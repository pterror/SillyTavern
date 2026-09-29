import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The groups search index reads every file in the groups folder, so every write or delete of one, not only those that
// go through a group's row, must add a groups version log row.

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

beforeEach(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-group-changes-file-writers-test-'));
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
    await metadataDb.ensureSchemaMigrated(directories);
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @returns {number} */
function maxVersion() {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    try {
        return /** @type {number} */ (db.prepare('SELECT COALESCE(MAX(version), 0) FROM group_changes').pluck().get());
    } finally {
        db.close();
    }
}

/** The group ids of the log rows added by `act`, in order. @param {() => Promise<unknown>} act */
async function addedBy(act) {
    const before = maxVersion();
    await act();
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    try {
        return db.prepare('SELECT group_id FROM group_changes WHERE version > ? ORDER BY version').pluck().all(before);
    } finally {
        db.close();
    }
}

/** @param {string} name @param {object} group */
function writeRawFile(name, group) {
    fs.writeFileSync(path.join(directories.groups, name), JSON.stringify(group));
}

describe('writeGroupFile at a path other than the group\'s own <id>.json', () => {
    test('adds a row for the group when the file changes, and none when a rewrite leaves its bytes as they were', async () => {
        const filePath = path.join(directories.groups, 'renamed.json');
        writeRawFile('renamed.json', { id: '123', name: 'g', members: ['a.png'], chats: [] });
        const group = { id: '123', name: 'g', members: ['b.png'], chats: [] };

        expect(await addedBy(() => groupsModule.writeGroupFile(directories, group, { filePath, createRow: false }))).toEqual(['123']);
        expect(await addedBy(() => groupsModule.writeGroupFile(directories, { ...group }, { filePath, createRow: false }))).toEqual([]);
    });

    test('adds a row for a legacy non-digit group id, which is a real id', async () => {
        const filePath = path.join(directories.groups, 'legacy.json');
        writeRawFile('legacy.json', { id: 'my group', name: 'g', members: ['a.png'], chats: [] });

        expect(await addedBy(() => groupsModule.writeGroupFile(directories, { id: 'my group', name: 'g', members: ['b.png'], chats: [] }, { filePath, createRow: false }))).toEqual(['my group']);
    });

    test('adds a NULL ("every group") row when the file has no id', async () => {
        const filePath = path.join(directories.groups, 'no-id.json');
        writeRawFile('no-id.json', { name: 'g', members: ['a.png'], chats: [] });

        expect(await addedBy(() => groupsModule.writeGroupFile(directories, { name: 'g', members: ['b.png'], chats: [] }, { filePath, createRow: false }))).toEqual([null]);
    });
});

describe('/api/groups/delete', () => {
    /** @param {string} id */
    async function deleteGroup(id) {
        const response = await fetch(`${baseUrl}/api/groups/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        expect(response.status).toBe(200);
    }

    test('adds one row when it deletes a group file, whether or not the group had rows', async () => {
        writeRawFile('100.json', { id: '100', name: 'no row', members: [], chats: [] });
        const withRow = { id: '200', name: 'with row', members: [], chats: [] };
        writeRawFile('200.json', withRow);
        await metadataDb.upsertGroupRow(directories, '200', withRow.name, { fav: false, group: withRow });

        expect(await addedBy(() => deleteGroup('100'))).toEqual(['100']);
        expect(await addedBy(() => deleteGroup('200'))).toEqual(['200']);
        expect(fs.existsSync(path.join(directories.groups, '100.json'))).toBe(false);
        expect(await addedBy(() => deleteGroup('100'))).toEqual([]);
    });
});
