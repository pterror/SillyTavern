import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// No usable SQLite engine: the metadata store, and with it the groups version log, is unavailable.
jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    getSqliteEngine: jest.fn(async () => null),
    isBusyError: () => false,
    getBusyWaitMs: () => 0,
    openNativeDatabase: jest.fn(),
    openWasmDatabase: jest.fn(),
    streamRows: jest.fn(),
    streamWrite: jest.fn(),
}));

/** @type {typeof import('../src/endpoints/groups-search-index.js')} */
let groupsSearchIndex;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {any} */
let tantivy;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    groupsSearchIndex = await import('../src/endpoints/groups-search-index.js');
    metadataDb = await import('../src/character-metadata-db.js');
    tantivy = await (await import('../src/endpoints/tantivy-engine.js')).getTantivyModule();
});

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-groups-search-index-no-store-test-'));
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
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @param {string} id */
const groupFile = (id) => path.join(directories.groups, `${id}.json`);

describe('createGroupIndexMaintainer without a metadata store', () => {
    test('rebuilds when a group file is added or removed', async () => {
        if (!tantivy) return;
        expect(await metadataDb.getGroupsVersion(directories)).toBeNull();

        fs.writeFileSync(groupFile('g1'), JSON.stringify({ id: 'g1', name: 'First', members: [], chats: [] }));
        const maintainer = groupsSearchIndex.createGroupIndexMaintainer(directories, tantivy);
        await maintainer.build();
        expect(maintainer.version()).toBeNull();
        expect(await maintainer.tick()).toBeNull();

        fs.writeFileSync(groupFile('g2'), JSON.stringify({ id: 'g2', name: 'Second', members: [], chats: [] }));
        expect(await maintainer.tick()).not.toBeNull();
        expect(await maintainer.tick()).toBeNull();

        fs.rmSync(groupFile('g1'));
        expect(await maintainer.tick()).not.toBeNull();
        expect(await maintainer.tick()).toBeNull();
    }, 30000);
});
