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

/** While set, every insert into group_changes through the store's handle throws. */
let failLogInsert = false;

/** @param {any} handle */
function instrumentedHandle(handle) {
    const wrapped = { ...handle };
    wrapped.run = (sql, params) => {
        if (failLogInsert && /INTO group_changes/.test(sql)) throw new Error('simulated log insert failure');
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-group-changes-log-test-'));
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
    failLogInsert = false;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    failLogInsert = false;
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

const dbPath = () => path.join(directories.root, 'character-metadata.sqlite');

/** @template T @param {(db: import('better-sqlite3').Database) => T} fn @returns {T} */
function withRawDb(fn) {
    const db = new Database(dbPath());
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** @returns {{ version: number, group_id: string | null }[]} */
function logRows() {
    return withRawDb(db => /** @type {any[]} */ (db.prepare('SELECT version, group_id FROM group_changes ORDER BY version').all()));
}

/** @returns {number} */
function maxVersion() {
    return withRawDb(db => /** @type {number} */ (db.prepare('SELECT COALESCE(MAX(version), 0) FROM group_changes').pluck().get()));
}

/** The group ids of the log rows added by `act`, in order. @param {() => Promise<unknown>} act */
async function addedBy(act) {
    const before = maxVersion();
    await act();
    return logRows().filter(row => row.version > before).map(row => row.group_id);
}

/** Every groups and group_tags row, for comparing before and after a write. */
function groupTables() {
    return withRawDb(db => JSON.stringify({
        groups: db.prepare('SELECT * FROM groups ORDER BY id').all(),
        groupTags: db.prepare('SELECT * FROM group_tags ORDER BY group_id, tag_id').all(),
    }));
}

const groupFile = (/** @type {string} */ id) => path.join(directories.groups, `${id}.json`);

/** @param {string} id @param {object} [fields] */
function writeGroupFileRaw(id, fields = {}) {
    const group = { id, name: `group ${id}`, members: [], chats: [], fav: false, ...fields };
    fs.writeFileSync(groupFile(id), JSON.stringify(group));
    return group;
}

/** A group with a file and a row. @param {string} id @param {object} [fields] */
async function seedGroup(id, fields = {}) {
    const group = writeGroupFileRaw(id, fields);
    await metadataDb.upsertGroupRow(directories, id, group.name, { fav: false, group });
    return group;
}

/** @param {string[]} ids */
async function saveTags(ids) {
    expect(await metadataDb.saveTagDefinitions(directories, ids.map(id => ({ id, name: `name-${id}` })))).toBe('ok');
}

/** @param {object} group */
async function writeThroughStore(group, options = {}) {
    const text = JSON.stringify(group);
    await metadataDb.writeGroupFileAndRow(directories, group, () => fs.writeFileSync(groupFile(/** @type {any} */ (group).id), text), options);
}

/** Opens the store so its schema exists, with no group rows. */
async function openStore() {
    expect(await metadataDb.getGroupsVersion(directories)).toBe(0);
}

/**
 * Each writer: `setup` runs first, then `act` must add exactly `rows`; running `act` again (after `again`) must add
 * none. With the log insert failing, `act` must leave the groups and group_tags rows as they were, except with
 * `nullsDigestFirst`, whose failure is checked on its own below.
 * @type {{ name: string, setup: () => Promise<void>, act: () => Promise<unknown>, rows: (string | null)[], again?: () => Promise<void>, nullsDigestFirst?: boolean }[]}
 */
const WRITERS = [
    {
        name: 'upsertGroupRow',
        setup: openStore,
        act: () => metadataDb.upsertGroupRow(directories, '1001', 'one', { group: { id: '1001', name: 'one' } }),
        rows: ['1001'],
    },
    {
        name: 'writeGroupFileAndRow, a changed group',
        setup: async () => { await seedGroup('1001'); },
        act: () => writeThroughStore({ id: '1001', name: 'renamed', members: ['a.png'], chats: [], fav: false }),
        rows: ['1001'],
        nullsDigestFirst: true,
    },
    {
        name: 'writeGroupFileAndRow, a new group',
        setup: openStore,
        act: () => writeThroughStore({ id: '1001', name: 'new', members: [], chats: [], fav: true }),
        rows: ['1001'],
    },
    {
        name: 'bumpGroupChatStats',
        setup: async () => { await seedGroup('1001'); },
        act: () => metadataDb.bumpGroupChatStats(directories, /** @type {any} */ (null), { groupId: '1001', stats: { chatSize: 50, dateLastChat: 1234 } }),
        rows: ['1001'],
    },
    {
        name: 'deleteGroupRow',
        setup: async () => {
            await saveTags(['x']);
            await seedGroup('1001');
            await metadataDb.assignEntityTag(directories, '1001', 'x');
        },
        act: () => metadataDb.deleteGroupRow(directories, '1001'),
        rows: ['1001'],
    },
    {
        name: 'assignEntityTag',
        setup: async () => {
            await saveTags(['x']);
            await seedGroup('1001');
        },
        act: () => metadataDb.assignEntityTag(directories, '1001', 'x'),
        rows: ['1001'],
    },
    {
        name: 'unassignEntityTag',
        setup: async () => {
            await saveTags(['x']);
            await seedGroup('1001');
            await metadataDb.assignEntityTag(directories, '1001', 'x');
        },
        act: () => metadataDb.unassignEntityTag(directories, '1001', 'x'),
        rows: ['1001'],
    },
    {
        name: 'setEntityTagIdsMany',
        setup: async () => {
            await saveTags(['x', 'y']);
            await seedGroup('1001');
            await seedGroup('1002');
            await metadataDb.setEntityTagIdsMany(directories, { 1002: ['x'] });
        },
        act: () => metadataDb.setEntityTagIdsMany(directories, { 1001: ['x', 'y'], 1002: ['x'] }),
        rows: ['1001'],
    },
    {
        name: 'restoreTagMap',
        setup: async () => {
            await saveTags(['x']);
            await seedGroup('1001');
        },
        act: () => metadataDb.restoreTagMap(directories, { 1001: ['x'] }),
        rows: ['1001'],
    },
    {
        name: 'migrateTagsJsonIfNeeded',
        setup: async () => {
            await saveTags(['x']);
            await seedGroup('1001');
            fs.writeFileSync(path.join(directories.root, 'tags.json'), JSON.stringify({ tags: [{ id: 'x', name: 'name-x' }], tag_map: { 1001: ['x'] } }));
        },
        act: () => metadataDb.migrateTagsJsonIfNeeded(directories),
        again: async () => withRawDb(db => { db.prepare('DELETE FROM meta WHERE key = \'tags_json_migrated\'').run(); }),
        rows: ['1001'],
    },
    {
        name: 'bootstrapGroupsIfNeeded',
        setup: async () => {
            await openStore();
            writeGroupFileRaw('1001');
            writeGroupFileRaw('1002');
        },
        act: () => metadataDb.bootstrapGroupsIfNeeded(directories),
        again: async () => withRawDb(db => { db.prepare('DELETE FROM meta WHERE key = \'groups_bootstrap_completed\'').run(); }),
        rows: ['1001', '1002'],
    },
    {
        name: 'recoverNumericIdGroupsIfNeeded',
        setup: async () => {
            await openStore();
            fs.writeFileSync(groupFile('1001'), JSON.stringify({ id: 1001, name: 'numeric', members: [], chats: [] }));
        },
        act: () => metadataDb.recoverNumericIdGroupsIfNeeded(directories),
        again: async () => withRawDb(db => { db.prepare('DELETE FROM meta WHERE key = ?').run(metadataDb.GROUP_NUMERIC_ID_RECOVERY_FLAG); }),
        rows: ['1001'],
    },
    {
        name: 'normalizeGroupFavIfNeeded',
        setup: async () => {
            await seedGroup('1001');
            await seedGroup('1002');
            withRawDb(db => { db.prepare('UPDATE groups SET fav = 1 WHERE id = \'1001\'').run(); });
        },
        act: () => metadataDb.normalizeGroupFavIfNeeded(directories),
        again: async () => withRawDb(db => { db.prepare('DELETE FROM meta WHERE key = ?').run(metadataDb.GROUP_FAV_NORMALIZED_FLAG); }),
        rows: ['1001'],
    },
    {
        name: 'finishDeletedTags',
        setup: async () => {
            await saveTags(['x', 'y']);
            await seedGroup('1001');
            await seedGroup('1002');
            await metadataDb.assignEntityTag(directories, '1001', 'x');
            await metadataDb.assignEntityTag(directories, '1002', 'y');
            await metadataDb.deleteTagDefinition(directories, 'x', 'y');
        },
        act: () => metadataDb.finishDeletedTags(directories),
        rows: ['1001'],
    },
    {
        name: 'removeOrphanTagRowsIfNeeded',
        setup: async () => {
            await saveTags(['x']);
            await seedGroup('1001');
            await metadataDb.assignEntityTag(directories, '1001', 'x');
            withRawDb(db => { db.prepare('INSERT INTO group_tags (group_id, tag_id) VALUES (\'9999\', \'x\')').run(); });
        },
        act: () => metadataDb.removeOrphanTagRowsIfNeeded(directories),
        again: async () => withRawDb(db => { db.prepare('DELETE FROM meta WHERE key = ?').run(metadataDb.ORPHAN_TAG_ROWS_REMOVED_FLAG); }),
        rows: ['9999'],
    },
    {
        name: 'refreshGroupDigestTagIdsIfNeeded',
        setup: async () => {
            await saveTags(['x']);
            await seedGroup('1001');
            await seedGroup('1002');
            await metadataDb.assignEntityTag(directories, '1001', 'x');
            await metadataDb.assignEntityTag(directories, '1002', 'x');
            withRawDb(db => { db.prepare('UPDATE groups SET digest_tag_ids = 12345 WHERE id = \'1001\'').run(); });
        },
        act: () => metadataDb.refreshGroupDigestTagIdsIfNeeded(directories),
        again: async () => withRawDb(db => { db.prepare('DELETE FROM meta WHERE key = ?').run(metadataDb.GROUP_DIGEST_TAG_IDS_REFRESHED_FLAG); }),
        rows: ['1001'],
    },
];

describe('the groups version log', () => {
    test.each(WRITERS)('$name adds its row(s), and none when it changes nothing', async ({ setup, act, rows, again }) => {
        await setup();

        expect(await addedBy(act)).toEqual(rows);

        await again?.();
        expect(await addedBy(act)).toEqual([]);
    });

    test.each(WRITERS.filter(writer => !writer.nullsDigestFirst))('$name adds its row(s) in the same transaction as its write', async ({ setup, act }) => {
        await setup();
        const before = groupTables();

        failLogInsert = true;
        try {
            await act();
        } catch {
            // A writer may throw the failure or log it; either way its write must not have landed.
        }
        failLogInsert = false;

        expect(groupTables()).toEqual(before);
    });

    test('writeGroupFileAndRow: rewriting the same group adds no row', async () => {
        const group = await seedGroup('1001');
        await writeThroughStore(group);

        expect(await addedBy(() => writeThroughStore(group))).toEqual([]);
    });

    test('writeGroupFileAndRow: a changed file adds a row even with no row to update', async () => {
        await openStore();
        writeGroupFileRaw('1001');

        expect(await addedBy(() => writeThroughStore({ id: '1001', name: 'changed', members: [], chats: [] }, { createIfMissing: false }))).toEqual(['1001']);
        expect(withRawDb(db => db.prepare('SELECT 1 FROM groups WHERE id = \'1001\'').get())).toBeUndefined();
        expect(await addedBy(() => writeThroughStore({ id: '1001', name: 'changed', members: [], chats: [] }, { createIfMissing: false }))).toEqual([]);
    });

    test('writeGroupFileAndRow: when the log insert fails the row update is rolled back with it, and the digest stays NULL', async () => {
        await seedGroup('1001');

        failLogInsert = true;
        await writeThroughStore({ id: '1001', name: 'renamed', members: [], chats: [] });
        failLogInsert = false;

        const row = withRawDb(db => /** @type {any} */ (db.prepare('SELECT name, digest_content FROM groups WHERE id = \'1001\'').get()));
        expect(row).toEqual({ name: 'group 1001', digest_content: null });
    });
});

describe('migrations run when the store opens', () => {
    test('migrateGroupsColumns adds a row per group it fills in', async () => {
        writeGroupFileRaw('1001', { name: 'from file' });
        withRawDb(db => {
            db.exec('CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
            db.prepare('INSERT INTO groups (id, name) VALUES (\'1001\', \'old\')').run();
        });

        await metadataDb.getGroupsVersion(directories);

        // Once for its columns, once for the digest columns migrateGroupDigestColumns() then fills.
        expect(logRows().map(row => row.group_id)).toEqual(['1001', '1001']);
        expect(withRawDb(db => db.prepare('SELECT name FROM groups').pluck().get())).toBe('from file');
    });

    test('migrateGroupDigestColumns adds a row per group whose digests it sets', async () => {
        writeGroupFileRaw('1001');
        withRawDb(db => {
            db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_fold TEXT NOT NULL DEFAULT '', fav INTEGER NOT NULL DEFAULT 0,
                date_added INTEGER NOT NULL DEFAULT 0, date_last_chat INTEGER NOT NULL DEFAULT 0, chat_size INTEGER NOT NULL DEFAULT 0)`);
            db.prepare('INSERT INTO groups (id, name) VALUES (\'1001\', \'group 1001\')').run();
        });

        await metadataDb.getGroupsVersion(directories);

        expect(logRows().map(row => row.group_id)).toEqual(['1001']);
    });

    test('a migration whose log insert fails leaves the group row as it was', async () => {
        writeGroupFileRaw('1001');
        withRawDb(db => {
            db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_fold TEXT NOT NULL DEFAULT '', fav INTEGER NOT NULL DEFAULT 0,
                date_added INTEGER NOT NULL DEFAULT 0, date_last_chat INTEGER NOT NULL DEFAULT 0, chat_size INTEGER NOT NULL DEFAULT 0)`);
            db.prepare('INSERT INTO groups (id, name) VALUES (\'1001\', \'group 1001\')').run();
        });

        failLogInsert = true;
        await expect(metadataDb.getGroupsVersion(directories)).rejects.toThrow('simulated log insert failure');
        failLogInsert = false;

        expect(withRawDb(db => db.prepare('SELECT digest_content FROM groups').pluck().get())).toBeNull();
    });
});

describe('tag renames', () => {
    test('saveTagDefinitions adds a NULL row per renamed tag, and none when no name changed', async () => {
        await saveTags(['x', 'y']);

        expect(await addedBy(() => metadataDb.saveTagDefinitions(directories, [{ id: 'x', name: 'new-x' }, { id: 'y', name: 'new-y' }]))).toEqual([null, null]);
        expect(await addedBy(() => metadataDb.saveTagDefinitions(directories, [{ id: 'x', name: 'new-x' }, { id: 'y', name: 'new-y', color: '#fff' }]))).toEqual([]);
    });

    test('editTagDefinition adds a NULL row for a name change, and none for another field', async () => {
        await saveTags(['x']);

        expect(await addedBy(() => metadataDb.editTagDefinition(directories, 'x', { name: 'new-x' }))).toEqual([null]);
        expect(await addedBy(() => metadataDb.editTagDefinition(directories, 'x', { color: '#fff' }))).toEqual([]);
    });

    test('deleteTagDefinition adds a NULL row for each tag whose name changes', async () => {
        await saveTags(['x', 'y', 'z']);
        await metadataDb.deleteTagDefinition(directories, 'x', 'y');

        // y and x, which now reads as y.
        expect(await addedBy(() => metadataDb.deleteTagDefinition(directories, 'y', 'z'))).toEqual([null, null]);
        expect(await addedBy(() => metadataDb.deleteTagDefinition(directories, 'y', 'z'))).toEqual([]);
    });

    test.each([
        ['saveTagDefinitions', () => metadataDb.saveTagDefinitions(directories, [{ id: 'x', name: 'new-x' }])],
        ['editTagDefinition', () => metadataDb.editTagDefinition(directories, 'x', { name: 'new-x' })],
        ['deleteTagDefinition', () => metadataDb.deleteTagDefinition(directories, 'x')],
    ])('%s adds its NULL row in the same transaction as its tag_name_changes row', async (_name, act) => {
        await saveTags(['x']);
        const renames = () => withRawDb(db => db.prepare('SELECT COUNT(*) FROM tag_name_changes').pluck().get());
        const before = renames();

        failLogInsert = true;
        await expect(act()).rejects.toThrow('simulated log insert failure');
        failLogInsert = false;

        expect(renames()).toBe(before);
    });
});

describe('getGroupsVersion', () => {
    test('is 0 for an empty log and the latest version after writes', async () => {
        expect(await metadataDb.getGroupsVersion(directories)).toBe(0);

        await seedGroup('1001');
        await seedGroup('1002');
        await saveTags(['x']);
        await metadataDb.editTagDefinition(directories, 'x', { name: 'new-x' });

        const rows = logRows();
        expect(rows.map(row => row.group_id)).toEqual(['1001', '1002', null]);
        expect(await metadataDb.getGroupsVersion(directories)).toBe(rows[rows.length - 1].version);
    });
});
