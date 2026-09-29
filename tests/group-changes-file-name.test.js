import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Every groups version log row records the name of the group JSON file its write wrote, replaced or removed, and
// NULL when the write touched no file. group_id stays the group's id (NULL for a tag rename or a file with no id).

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/groups.js')} */
let groupsModule;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    groupsModule = await import('../src/endpoints/groups.js');
    Database = (await import('better-sqlite3')).default;

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/groups', groupsModule.router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-group-changes-file-name-test-'));
    directories = /** @type {any} */ ({
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'groupChats'),
        backups: path.join(root, 'backups'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats, directories.backups]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
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

/** @returns {{ version: number, group_id: string | null, file_name: string | null }[]} */
function logRows() {
    return withRawDb(db => /** @type {any[]} */ (Array.from(db.prepare('SELECT version, group_id, file_name FROM group_changes ORDER BY version').iterate())));
}

/** @returns {number} */
function maxVersion() {
    return withRawDb(db => /** @type {number} */ (db.prepare('SELECT COALESCE(MAX(version), 0) FROM group_changes').pluck().get()));
}

/** The [group_id, file_name] of each log row added by `act`, in order. @param {() => Promise<unknown>} act */
async function addedBy(act) {
    const before = maxVersion();
    await act();
    return logRows().filter(row => row.version > before).map(row => [row.group_id, row.file_name]);
}

/** @param {string} name */
const groupPath = (name) => path.join(directories.groups, name);

/** @param {string} name @param {object} group */
function writeRawFile(name, group) {
    fs.writeFileSync(groupPath(name), JSON.stringify(group));
}

/** @param {string} id @param {object} [fields] */
function writeGroupFileRaw(id, fields = {}) {
    const group = { id, name: `group ${id}`, members: [], chats: [], fav: false, ...fields };
    writeRawFile(`${id}.json`, group);
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

/** @param {object} group @param {object} [options] */
async function writeThroughStore(group, options = {}) {
    const text = JSON.stringify(group);
    const id = /** @type {any} */ (group).id;
    await metadataDb.writeGroupFileAndRow(directories, group, () => fs.writeFileSync(groupPath(`${id}.json`), text), options);
}

async function openStore() {
    expect(await metadataDb.getGroupsVersion(directories)).toBe(0);
}

/** @param {string} id */
async function deleteThroughRoute(id) {
    const response = await fetch(`${baseUrl}/api/groups/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
    });
    expect(response.status).toBe(200);
}

/**
 * Each writer: `setup` runs first, then `act` must add exactly `rows`, each [group_id, file_name].
 * @type {{ name: string, setup: () => Promise<void>, act: () => Promise<unknown>, rows: [string | null, string | null][] }[]}
 */
const WRITERS = [
    {
        name: 'writeGroupFileAndRow, a changed group',
        setup: async () => { await seedGroup('1001'); },
        act: () => writeThroughStore({ id: '1001', name: 'renamed', members: ['a.png'], chats: [], fav: false }),
        rows: [['1001', '1001.json']],
    },
    {
        name: 'writeGroupFileAndRow, a new group',
        setup: openStore,
        act: () => writeThroughStore({ id: '1001', name: 'new', members: [], chats: [], fav: true }),
        rows: [['1001', '1001.json']],
    },
    {
        name: 'writeGroupFileAndRow, a changed file with no row to update',
        setup: async () => { await openStore(); writeGroupFileRaw('1001'); },
        act: () => writeThroughStore({ id: '1001', name: 'changed', members: [], chats: [] }, { createIfMissing: false }),
        rows: [['1001', '1001.json']],
    },
    {
        name: 'writeGroupFileAndRow, a changed row with the file\'s bytes as they were',
        setup: async () => {
            const group = writeGroupFileRaw('1001');
            await metadataDb.upsertGroupRow(directories, '1001', 'stale name', { fav: false, group });
        },
        act: async () => {
            const text = fs.readFileSync(groupPath('1001.json'), 'utf8');
            await metadataDb.writeGroupFileAndRow(directories, JSON.parse(text), () => fs.writeFileSync(groupPath('1001.json'), text));
        },
        rows: [['1001', '1001.json']],
    },
    {
        name: 'writeGroupFile at the group\'s own <id>.json',
        setup: async () => { await seedGroup('1001'); },
        act: () => groupsModule.writeGroupFile(directories, { id: '1001', name: 'renamed', members: [], chats: [] }),
        rows: [['1001', '1001.json']],
    },
    {
        name: 'writeGroupFile at another path, a group with an id',
        setup: async () => { await openStore(); writeRawFile('renamed.json', { id: '123', name: 'g', members: ['a.png'], chats: [] }); },
        act: () => groupsModule.writeGroupFile(directories, { id: '123', name: 'g', members: ['b.png'], chats: [] }, { filePath: groupPath('renamed.json'), createRow: false }),
        rows: [['123', 'renamed.json']],
    },
    {
        name: 'writeGroupFile at another path, a legacy non-digit id',
        setup: async () => { await openStore(); writeRawFile('legacy.json', { id: 'my group', name: 'g', members: ['a.png'], chats: [] }); },
        act: () => groupsModule.writeGroupFile(directories, { id: 'my group', name: 'g', members: ['b.png'], chats: [] }, { filePath: groupPath('legacy.json'), createRow: false }),
        rows: [['my group', 'legacy.json']],
    },
    {
        name: 'writeGroupFileAtOtherPath, a file with no id',
        setup: async () => { await openStore(); writeRawFile('no-id.json', { name: 'g', members: ['a.png'], chats: [] }); },
        act: () => groupsModule.writeGroupFile(directories, { name: 'g', members: ['b.png'], chats: [] }, { filePath: groupPath('no-id.json'), createRow: false }),
        rows: [[null, 'no-id.json']],
    },
    {
        name: '/api/groups/delete removing a file whose group has a row',
        setup: async () => { await seedGroup('200'); },
        act: () => deleteThroughRoute('200'),
        rows: [['200', '200.json']],
    },
    {
        name: '/api/groups/delete removing a file whose group has no row',
        setup: async () => { await openStore(); writeGroupFileRaw('100'); },
        act: () => deleteThroughRoute('100'),
        rows: [['100', '100.json']],
    },
    {
        name: 'deleteGroupRow with no file deleted',
        setup: async () => { await seedGroup('1001'); },
        act: () => metadataDb.deleteGroupRow(directories, '1001'),
        rows: [['1001', null]],
    },
    {
        name: 'upsertGroupRow',
        setup: openStore,
        act: () => metadataDb.upsertGroupRow(directories, '1001', 'one', { group: { id: '1001', name: 'one' } }),
        rows: [['1001', null]],
    },
    {
        name: 'applyGroupChatStats',
        setup: async () => { await seedGroup('1001'); },
        act: () => metadataDb.applyGroupChatStats(directories, '1001', { sizeChange: 0, addedCreatedAt: 1234, readLastCreatedAt: null }),
        rows: [['1001', null]],
    },
    {
        name: 'assignEntityTag',
        setup: async () => { await saveTags(['x']); await seedGroup('1001'); },
        act: () => metadataDb.assignEntityTag(directories, '1001', 'x'),
        rows: [['1001', null]],
    },
    {
        name: 'unassignEntityTag',
        setup: async () => { await saveTags(['x']); await seedGroup('1001'); await metadataDb.assignEntityTag(directories, '1001', 'x'); },
        act: () => metadataDb.unassignEntityTag(directories, '1001', 'x'),
        rows: [['1001', null]],
    },
    {
        name: 'setEntityTagIdsMany',
        setup: async () => { await saveTags(['x']); await seedGroup('1001'); },
        act: () => metadataDb.setEntityTagIdsMany(directories, { 1001: ['x'] }),
        rows: [['1001', null]],
    },
    {
        name: 'migrateTagsJsonIfNeeded',
        setup: async () => {
            await saveTags(['x']);
            await seedGroup('1001');
            fs.writeFileSync(path.join(directories.root, 'tags.json'), JSON.stringify({ tags: [{ id: 'x', name: 'name-x' }], tag_map: { 1001: ['x'] } }));
        },
        act: () => metadataDb.migrateTagsJsonIfNeeded(directories),
        rows: [['1001', null]],
    },
    {
        name: 'bootstrapGroupsIfNeeded',
        setup: async () => { await openStore(); writeGroupFileRaw('1001'); },
        act: () => metadataDb.bootstrapGroupsIfNeeded(directories),
        rows: [['1001', null]],
    },
    {
        name: 'recoverNumericIdGroupsIfNeeded',
        setup: async () => { await openStore(); writeRawFile('1001.json', { id: 1001, name: 'numeric', members: [], chats: [] }); },
        act: () => metadataDb.recoverNumericIdGroupsIfNeeded(directories),
        rows: [['1001', null]],
    },
    {
        name: 'normalizeGroupFavIfNeeded',
        setup: async () => { await seedGroup('1001'); withRawDb(db => { db.prepare('UPDATE groups SET fav = 1 WHERE id = \'1001\'').run(); }); },
        act: () => metadataDb.normalizeGroupFavIfNeeded(directories),
        rows: [['1001', null]],
    },
    {
        name: 'finishDeletedTags',
        setup: async () => {
            await saveTags(['x', 'y']);
            await seedGroup('1001');
            await metadataDb.assignEntityTag(directories, '1001', 'x');
            await metadataDb.deleteTagDefinition(directories, 'x', 'y');
        },
        act: () => metadataDb.finishDeletedTags(directories),
        rows: [['1001', null]],
    },
    {
        name: 'removeOrphanTagRowsIfNeeded',
        setup: async () => {
            await saveTags(['x']);
            await openStore();
            withRawDb(db => { db.prepare('INSERT INTO group_tags (group_id, tag_id) VALUES (\'9999\', \'x\')').run(); });
        },
        act: () => metadataDb.removeOrphanTagRowsIfNeeded(directories),
        rows: [['9999', null]],
    },
    {
        name: 'refreshGroupDigestTagIdsIfNeeded',
        setup: async () => {
            await saveTags(['x']);
            await seedGroup('1001');
            await metadataDb.assignEntityTag(directories, '1001', 'x');
            withRawDb(db => { db.prepare('UPDATE groups SET digest_tag_ids = 12345 WHERE id = \'1001\'').run(); });
        },
        act: () => metadataDb.refreshGroupDigestTagIdsIfNeeded(directories),
        rows: [['1001', null]],
    },
    {
        name: 'saveTagDefinitions renaming a tag',
        setup: async () => { await saveTags(['x']); },
        act: () => metadataDb.saveTagDefinitions(directories, [{ id: 'x', name: 'new-x' }]),
        rows: [[null, null]],
    },
    {
        name: 'editTagDefinition renaming a tag',
        setup: async () => { await saveTags(['x']); },
        act: () => metadataDb.editTagDefinition(directories, 'x', { name: 'new-x' }),
        rows: [[null, null]],
    },
    {
        name: 'deleteTagDefinition',
        setup: async () => { await saveTags(['x']); },
        act: () => metadataDb.deleteTagDefinition(directories, 'x'),
        rows: [[null, null]],
    },
];

describe('group_changes.file_name', () => {
    test.each(WRITERS)('$name', async ({ setup, act, rows }) => {
        await setup();
        expect(await addedBy(act)).toEqual(rows);
    });

    test('writeGroupFileAndRow records the file it wrote, whose name the id is sanitized into', async () => {
        await openStore();
        const group = { id: 'a:b', name: 'g', members: [], chats: [] };
        const text = JSON.stringify(group);

        expect(await addedBy(() => metadataDb.writeGroupFileAndRow(directories, group, () => fs.writeFileSync(groupPath('ab.json'), text)))).toEqual([['a:b', 'ab.json']]);
    });
});

describe('the file_name migration', () => {
    test('adds the column to an old group_changes, keeps its rows with NULL, and later writes record their file', async () => {
        withRawDb(db => {
            db.exec('CREATE TABLE group_changes (version INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT)');
            db.prepare('INSERT INTO group_changes (group_id) VALUES (\'1001\'), (NULL)').run();
        });

        await metadataDb.getGroupsVersion(directories);

        const columns = withRawDb(db => Array.from(db.prepare('PRAGMA table_info(group_changes)').iterate(), (/** @type {any} */ c) => c.name));
        expect(columns).toEqual(['version', 'group_id', 'file_name']);
        expect(logRows()).toEqual([
            { version: 1, group_id: '1001', file_name: null },
            { version: 2, group_id: null, file_name: null },
        ]);

        await writeThroughStore({ id: '1001', name: 'g', members: [], chats: [] });
        expect(logRows().slice(2)).toEqual([{ version: 3, group_id: '1001', file_name: '1001.json' }]);
    });

    test('runs before the groups column migrations, whose rows it can then hold', async () => {
        writeGroupFileRaw('1001', { name: 'from file' });
        withRawDb(db => {
            db.exec('CREATE TABLE group_changes (version INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT)');
            db.exec('CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
            db.prepare('INSERT INTO groups (id, name) VALUES (\'1001\', \'old\')').run();
        });

        await metadataDb.getGroupsVersion(directories);

        // migrateGroupsColumns() and migrateGroupDigestColumns() write rows only, no file.
        expect(logRows().map(row => [row.group_id, row.file_name])).toEqual([['1001', null], ['1001', null]]);
        expect(withRawDb(db => db.prepare('SELECT name FROM groups').pluck().get())).toBe('from file');
    });
});
