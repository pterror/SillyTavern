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

describe('one-time character passes never leave a row half-written', () => {
    test('a write that throws rolls back its whole batch and fails the pass, which resumes after the last committed batch', async () => {
        await seedCopies(1500);
        markFavStale('1');
        /** @param {string} id */
        const changeRowsFor = id => withRawDb(db => db.prepare('SELECT COUNT(*) AS n FROM changes WHERE id = ?').get(id).n);

        // c01200.png's change row is written before its UPDATE, which then throws.
        failWrite = (sql, params) => sql.startsWith('UPDATE characters SET') && params?.id === 'c01200.png';
        await expect(metadataDb.normalizeCharacterFavIfNeeded(directories)).rejects.toThrow('simulated write failure');
        failWrite = null;

        expect(shallowOf('c00999.png').fav).toBe(false);
        expect(shallowOf('c01000.png').fav).toBe(true);
        expect(shallowOf('c01200.png').fav).toBe(true);
        expect(changeRowsFor('c01000.png')).toBe(0);
        expect(changeRowsFor('c01200.png')).toBe(0);
        expect(rawMeta('character_fav_normalized_v1_progress')).toBe('c00999.png');
        expect(rawMeta('character_fav_normalized_v1')).toBeNull();

        const result = await metadataDb.normalizeCharacterFavIfNeeded(directories);

        expect(result).toEqual({ batches: 1, rowsChanged: 501 });
        expect(shallowOf('c01200.png').fav).toBe(false);
        expect(changeRowsFor('c01200.png')).toBe(1);
        expect(rawMeta('character_fav_normalized_v1')).not.toBeNull();
        expect(rawMeta('character_fav_normalized_v1_progress')).toBeNull();
    }, 60000);
});

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
        const columns = db.prepare('SELECT name FROM pragma_table_info(\'groups\')').pluck().all().filter(c => c !== 'id');
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

/** @param {string} where @param {string[]} tags */
function setCardTags(where, tags) {
    withRawDb(db => db.prepare(`UPDATE characters SET shallow_json = json_set(shallow_json, '$.data.tags', json(?)) WHERE ${where}`).run(JSON.stringify(tags)));
}

/** @param {string} id */
function assignedTagIds(id) {
    return withRawDb(db => db.prepare('SELECT tag_id FROM character_tags WHERE character_id = ?').pluck().all(id));
}

/** @param {string} name */
function tagIdsNamed(name) {
    return withRawDb(db => db.prepare('SELECT id FROM tags WHERE json_extract(data, \'$.name\') = ?').pluck().all(name));
}

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

    test('backfillCardTagsIfNeeded resumes after the last committed batch, reusing the tag the first run created', async () => {
        await seedCopies(1500);
        setCardTags('1', ['Alpha']);

        transactionCalls = 0;
        crashAtTransaction = 2;
        await expect(metadataDb.backfillCardTagsIfNeeded(directories)).rejects.toThrow('simulated stop');
        crashAtTransaction = 0;

        expect(rawMeta('card_tags_backfill_progress')).toBe('c00999.png');
        expect(rawMeta('card_tags_backfill_completed')).toBeNull();
        const [alphaId] = tagIdsNamed('Alpha');
        expect(assignedTagIds('c00999.png')).toEqual([alphaId]);
        expect(shallowOf('c00999.png').tag_ids).toEqual([alphaId]);
        expect(assignedTagIds('c01000.png')).toEqual([]);

        withRawDb(db => db.prepare('DELETE FROM character_tags WHERE character_id = \'c00000.png\'').run());
        const result = await metadataDb.backfillCardTagsIfNeeded(directories);

        expect(assignedTagIds('c00000.png')).toEqual([]);
        expect(assignedTagIds('c01000.png')).toEqual([alphaId]);
        expect(shallowOf('c01000.png').tag_ids).toEqual([alphaId]);
        expect(assignedTagIds('seed.png')).toEqual([alphaId]);
        expect(tagIdsNamed('Alpha')).toEqual([alphaId]);
        expect(result).toEqual({ batches: 1, rowsChanged: 501 });
        expect(rawMeta('card_tags_backfill_completed')).not.toBeNull();
        expect(rawMeta('card_tags_backfill_progress')).toBeNull();
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

    test('backfillCardTagsIfNeeded: the failed row is listed, the flag stays unset, and the next run starts over', async () => {
        await seedCopies(2);
        setCardTags('1', ['Alpha']);
        failRead = (sql, params) => sql.startsWith('SELECT shallow_json FROM characters WHERE id') && params?.id === 'c00001.png';
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await metadataDb.backfillCardTagsIfNeeded(directories);

        expect(result).toEqual({ batches: 1, rowsChanged: 2 });
        const [alphaId] = tagIdsNamed('Alpha');
        expect(assignedTagIds('c00000.png')).toEqual([alphaId]);
        expect(assignedTagIds('c00001.png')).toEqual([]);
        const warnings = warn.mock.calls.map(args => args.join(' '));
        expect(warnings.some(w => w.includes('c00001.png'))).toBe(true);
        expect(warnings.some(w => w.includes('c00000.png') || w.includes('seed.png'))).toBe(false);
        expect(rawMeta('card_tags_backfill_completed')).toBeNull();
        expect(rawMeta('card_tags_backfill_progress')).toBeNull();

        failRead = null;
        warn.mockClear();
        const rerun = await metadataDb.backfillCardTagsIfNeeded(directories);

        expect(rerun).toEqual({ batches: 1, rowsChanged: 1 });
        expect(assignedTagIds('c00001.png')).toEqual([alphaId]);
        expect(tagIdsNamed('Alpha')).toEqual([alphaId]);
        expect(warn).not.toHaveBeenCalled();
        expect(rawMeta('card_tags_backfill_completed')).not.toBeNull();
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

    test('migrateTagsJsonIfNeeded: the failed key is listed, the flag stays unset and tags.json stays in place', async () => {
        await seedCopies(2);
        withRawDb(db => db.prepare('UPDATE characters SET shallow_json = \'{broken\' WHERE id = \'c00001.png\'').run());
        const tagsJsonPath = path.join(directories.root, 'tags.json');
        fs.writeFileSync(tagsJsonPath, JSON.stringify({
            tags: [{ id: 'tag1', name: 'Funny' }],
            tag_map: { 'c00000.png': ['tag1'], 'c00001.png': ['tag1'] },
        }));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await metadataDb.migrateTagsJsonIfNeeded(directories);

        expect(result).toEqual({ batches: 2, rowsChanged: 2 });
        expect(assignedTagIds('c00000.png')).toEqual(['tag1']);
        expect(shallowOf('c00000.png').tag_ids).toEqual(['tag1']);
        expect(assignedTagIds('c00001.png')).toEqual([]);
        const warnings = warn.mock.calls.map(args => args.join(' '));
        expect(warnings.some(w => w.includes('c00001.png'))).toBe(true);
        expect(warnings.some(w => w.includes('c00000.png'))).toBe(false);
        expect(rawMeta('tags_json_migrated')).toBeNull();
        expect(fs.existsSync(tagsJsonPath)).toBe(true);
        expect(checkpointCalls).toContain('TRUNCATE');

        withRawDb(db => db.prepare('UPDATE characters SET shallow_json = (SELECT shallow_json FROM characters WHERE id = \'seed.png\') WHERE id = \'c00001.png\'').run());
        warn.mockClear();
        const rerun = await metadataDb.migrateTagsJsonIfNeeded(directories);

        expect(rerun).toEqual({ batches: 2, rowsChanged: 1 });
        expect(assignedTagIds('c00001.png')).toEqual(['tag1']);
        expect(warn).not.toHaveBeenCalled();
        expect(rawMeta('tags_json_migrated')).not.toBeNull();
        expect(fs.existsSync(tagsJsonPath)).toBe(false);
        expect(fs.existsSync(`${tagsJsonPath}.migrated`)).toBe(true);
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

    test('backfillCardTagsIfNeeded: a write that throws rolls back its whole batch, including a tag it created', async () => {
        await seedCopies(1500);
        setCardTags('1', ['Alpha']);
        setCardTags('id >= \'c01000.png\'', ['Alpha', 'Beta']);
        /** @param {string} id */
        const changeRowsFor = id => withRawDb(db => db.prepare('SELECT COUNT(*) AS n FROM changes WHERE id = ?').get(id).n);

        failWrite = (sql, params) => sql.startsWith('INSERT OR IGNORE INTO character_tags') && params?.characterId === 'c01200.png';
        await expect(metadataDb.backfillCardTagsIfNeeded(directories)).rejects.toThrow('simulated write failure');
        failWrite = null;

        const [alphaId] = tagIdsNamed('Alpha');
        expect(assignedTagIds('c00999.png')).toEqual([alphaId]);
        expect(assignedTagIds('c01000.png')).toEqual([]);
        expect(changeRowsFor('c01000.png')).toBe(0);
        expect(tagIdsNamed('Beta')).toEqual([]);
        expect(rawMeta('card_tags_backfill_progress')).toBe('c00999.png');
        expect(rawMeta('card_tags_backfill_completed')).toBeNull();

        const result = await metadataDb.backfillCardTagsIfNeeded(directories);

        expect(result).toEqual({ batches: 1, rowsChanged: 501 });
        const [betaId] = tagIdsNamed('Beta');
        expect(tagIdsNamed('Beta')).toHaveLength(1);
        expect(assignedTagIds('c01200.png').sort()).toEqual([alphaId, betaId].sort());
        expect(changeRowsFor('c01200.png')).toBe(1);
        expect(rawMeta('card_tags_backfill_completed')).not.toBeNull();
    }, 60000);
});
