import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';

// The groups index catches up from the groups version log (group_changes) and the tag-rename log
// (tag_name_changes), keyed by file name, instead of rebuilding on every change.

// One timeline of every engine call (method, SQL, arguments) and every group file read, in the order they happen.
/** @type {({ kind: 'sql', method: string, sql: string, args: any[] } | { kind: 'file', name: string })[]} */
const events = [];

async function getRecordingSqliteEngine() {
    const engine = await realSqliteEngine.getSqliteEngine();
    if (!engine) {
        return engine;
    }
    return {
        ...engine,
        openDatabase: (dbPath, options) => {
            const handle = engine.openDatabase(dbPath, options);
            for (const method of ['all', 'get', 'iterate', 'run', 'readBounded']) {
                const real = handle[method];
                handle[method] = (sql, ...args) => {
                    events.push({ kind: 'sql', method, sql, args });
                    return real(sql, ...args);
                };
            }
            return handle;
        },
    };
}

jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    ...realSqliteEngine,
    getSqliteEngine: getRecordingSqliteEngine,
}));

const FAV_SQL_PREFIX = 'SELECT id, fav FROM groups WHERE id IN (';
const GROUP_CHANGES_PAGE_SQL = 'SELECT version, group_id, file_name FROM group_changes WHERE version > ? ORDER BY version ASC LIMIT ?';
const VERSION_META_KEY = 'tantivy_group_index_version';
const TAG_NAME_SEQ_META_KEY = 'tantivy_group_index_tag_name_change_seq';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/groups-search-index.js')} */
let groupsSearchIndex;
/** @type {typeof import('../src/endpoints/tantivy-search.js')} */
let tantivySearch;
/** @type {any} */
let tantivy;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;
/** @type {ReturnType<typeof import('../src/endpoints/groups-search-index.js').createGroupIndexMaintainer>[]} */
let maintainers;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    groupsSearchIndex = await import('../src/endpoints/groups-search-index.js');
    tantivySearch = await import('../src/endpoints/tantivy-search.js');
    tantivy = await (await import('../src/endpoints/tantivy-engine.js')).getTantivyModule();
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-groups-search-index-catch-up-test-'));
    directories = /** @type {any} */ ({
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    events.length = 0;
    maintainers = [];
});

afterEach(() => {
    for (const maintainer of maintainers) maintainer.close();
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @param {{ tickBudgetMs?: number }} [options] */
async function builtMaintainer(options) {
    const maintainer = groupsSearchIndex.createGroupIndexMaintainer(directories, tantivy, options);
    maintainers.push(maintainer);
    await maintainer.build();
    return maintainer;
}

/**
 * Writes a group file the way the groups endpoints do: `<id>.json` with its row, or any other file name through
 * writeGroupFileAtOtherPath().
 * @param {object} group
 * @param {string} [fileName]
 */
async function writeGroup(group, fileName) {
    const own = fileName === undefined;
    const filePath = path.join(directories.groups, own ? `${/** @type {any} */ (group).id}.json` : fileName);
    const writeFile = () => fs.writeFileSync(filePath, JSON.stringify(group));
    if (own) {
        await metadataDb.writeGroupFileAndRow(directories, group, writeFile);
    } else {
        await metadataDb.writeGroupFileAtOtherPath(directories, group, filePath, writeFile);
    }
}

/**
 * @template T
 * @param {(db: import('better-sqlite3').Database) => T} fn
 * @returns {T}
 */
function withRawDb(fn) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** @returns {{ fileName: string, groupId: string | null, group: any }[]} Every doc in the index, by file name. */
function indexedDocs() {
    const index = tantivy.Index.open(path.join(directories.root, 'search-index', 'groups-tantivy'));
    const searcher = index.searcher();
    if (searcher.numDocs === 0) return [];
    const { hits } = searcher.search(tantivy.Query.allQuery(), searcher.numDocs, false);
    const docs = hits.map(hit => {
        const doc = searcher.doc(hit.docAddress);
        const fileName = doc.getFirst('file_name');
        const byGroupId = (id) => searcher.search(tantivy.Query.termQuery(index.schema, 'group_id', id), 10, true).count;
        const group = JSON.parse(doc.getFirst(tantivySearch.DATA_FIELD));
        return { fileName, groupId: typeof group.id === 'string' && byGroupId(group.id) > 0 ? group.id : null, group };
    });
    return docs.sort((a, b) => (a.fileName < b.fileName ? -1 : 1));
}

/** @returns {string[]} The file names of the docs whose tag names match `word`. */
function filesTagged(word) {
    const index = tantivy.Index.open(path.join(directories.root, 'search-index', 'groups-tantivy'));
    const searcher = index.searcher();
    if (searcher.numDocs === 0) return [];
    const { hits } = searcher.search(index.parseQuery(word, ['resolved_tags']), searcher.numDocs, false);
    return hits.map(hit => searcher.doc(hit.docAddress).getFirst('file_name')).sort();
}

/** Records the group files read from here on, and clears the timeline. */
function recordFileReads() {
    const realReadFileSync = fs.readFileSync;
    jest.spyOn(fs, 'readFileSync').mockImplementation((/** @type {any} */ file, /** @type {any} */ ...rest) => {
        if (typeof file === 'string' && path.dirname(file) === directories.groups) {
            events.push({ kind: 'file', name: path.basename(file) });
        }
        return /** @type {any} */ (realReadFileSync)(file, ...rest);
    });
    events.length = 0;
}

const filesRead = () => events.filter(e => e.kind === 'file').map(e => /** @type {any} */ (e).name).sort();
const sqlEvents = () => /** @type {{ kind: 'sql', method: string, sql: string, args: any[] }[]} */ (events.filter(e => e.kind === 'sql'));
const oneLine = (sql) => sql.replace(/\s+/g, ' ').trim();

async function saveTags() {
    expect(await metadataDb.saveTagDefinitions(directories, [{ id: 't1', name: 'witchy' }, { id: 't2', name: 'other' }])).toBe('ok');
}

describe('a group_changes row with a file name', () => {
    test('re-reads exactly that file and replaces its entry', async () => {
        if (!tantivy) return;
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        await writeGroup({ id: 'g2', name: 'Circle', members: [] });
        const maintainer = await builtMaintainer();

        await writeGroup({ id: 'g1', name: 'Renamed', members: ['a.png'] });
        recordFileReads();
        const result = await maintainer.tick();

        expect(result).toMatchObject({ changed: true, refreshed: 1, version: await metadataDb.getGroupsVersion(directories) });
        expect(filesRead()).toEqual(['g1.json']);
        expect(indexedDocs().map(d => [d.fileName, d.group.name, d.group.members])).toEqual([
            ['g1.json', 'Renamed', ['a.png']],
            ['g2.json', 'Circle', []],
        ]);
        expect(await maintainer.tick()).toBeNull();
    }, 30000);

    test('removes the entry of a file that is gone, without reading it', async () => {
        if (!tantivy) return;
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        await writeGroup({ id: 'g2', name: 'Circle', members: [] });
        const maintainer = await builtMaintainer();
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        fs.rmSync(path.join(directories.groups, 'g1.json'));
        await metadataDb.deleteGroupRow(directories, 'g1', { fileDeleted: true });
        recordFileReads();
        expect(await maintainer.tick()).toMatchObject({ changed: true, refreshed: 1 });

        expect(filesRead()).toEqual([]);
        expect(errorSpy).not.toHaveBeenCalled();
        expect(indexedDocs().map(d => d.fileName)).toEqual(['g2.json']);
    }, 30000);

    test('a file with no id is indexed and replaced by its file name, with no group_id', async () => {
        if (!tantivy) return;
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        const maintainer = await builtMaintainer();

        await writeGroup({ name: 'Nobody', members: [] }, 'noid.json');
        expect(await maintainer.tick()).toMatchObject({ changed: true, refreshed: 1 });
        await writeGroup({ name: 'Somebody', members: [] }, 'noid.json');
        expect(await maintainer.tick()).toMatchObject({ changed: true, refreshed: 1 });

        expect(indexedDocs().map(d => [d.fileName, d.groupId, d.group.name])).toEqual([
            ['g1.json', 'g1', 'Coven'],
            ['noid.json', null, 'Somebody'],
        ]);
    }, 30000);

    test('a file not named <id>.json is re-read on its own, and the <id>.json file with the same id is left alone', async () => {
        if (!tantivy) return;
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        await writeGroup({ id: 'g1', name: 'Copy', members: [] }, 'other.json');
        const maintainer = await builtMaintainer();

        await writeGroup({ id: 'g1', name: 'Moved Copy', members: [] }, 'other.json');
        recordFileReads();
        expect(await maintainer.tick()).toMatchObject({ changed: true, refreshed: 1 });

        expect(filesRead()).toEqual(['other.json']);
        expect(indexedDocs().map(d => [d.fileName, d.groupId, d.group.name])).toEqual([
            ['g1.json', 'g1', 'Coven'],
            ['other.json', 'g1', 'Moved Copy'],
        ]);
    }, 30000);

    test('a file that fails to parse loses its entry and is logged, as the full build leaves it out', async () => {
        if (!tantivy) return;
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        await writeGroup({ id: 'g2', name: 'Circle', members: [] });
        const maintainer = await builtMaintainer();
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const filePath = path.join(directories.groups, 'g1.json');
        await metadataDb.writeGroupFileAtOtherPath(directories, { id: 'g1' }, filePath, () => fs.writeFileSync(filePath, '{ not json'));
        expect(await maintainer.tick()).toMatchObject({ changed: true, refreshed: 1 });

        expect(errorSpy).toHaveBeenCalled();
        expect(indexedDocs().map(d => d.fileName)).toEqual(['g2.json']);
        await maintainer.build();
        expect(indexedDocs().map(d => d.fileName)).toEqual(['g2.json']);
    }, 30000);
});

describe('a group_changes row with only a group id', () => {
    test('re-reads every file indexed under that id, and no other', async () => {
        if (!tantivy) return;
        await saveTags();
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        await writeGroup({ id: 'g1', name: 'Copy', members: [] }, 'other.json');
        await writeGroup({ id: 'g2', name: 'Circle', members: [] });
        const maintainer = await builtMaintainer();

        await metadataDb.applyGroupChatStats(directories, 'g1', { sizeChange: 100, addedCreatedAt: 5, readLastCreatedAt: null });
        recordFileReads();
        expect(await maintainer.tick()).toMatchObject({ changed: true, refreshed: 2 });
        expect(filesRead()).toEqual(['g1.json', 'other.json']);
        expect(indexedDocs().map(d => [d.fileName, d.group.chat_size])).toEqual([
            ['g1.json', 100],
            ['g2.json', 0],
            ['other.json', 100],
        ]);

        expect(await metadataDb.assignEntityTag(directories, 'g1', 't1')).toBe('ok');
        expect(await maintainer.tick()).toMatchObject({ changed: true, refreshed: 2 });
        expect(filesTagged('witchy')).toEqual(['g1.json', 'other.json']);
    }, 30000);

    test('an id with no indexed file changes nothing, but the version still moves', async () => {
        if (!tantivy) return;
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        const maintainer = await builtMaintainer();
        await metadataDb.upsertGroupRow(directories, 'ghost', 'Ghost', { fav: true });

        const result = await maintainer.tick();
        expect(result).toMatchObject({ changed: false, refreshed: 0, version: await metadataDb.getGroupsVersion(directories) });
        expect(await metadataDb.getMetaValue(directories, VERSION_META_KEY)).toBe(String(await metadataDb.getGroupsVersion(directories)));
    }, 30000);

    test('across log pages, a file given an entry earlier in the same tick is re-read too', async () => {
        if (!tantivy) return;
        await saveTags();
        await writeGroup({ id: 'g2', name: 'Circle', members: [] });
        const maintainer = await builtMaintainer({ tickBudgetMs: 60000 });

        // Page 1: g9.json is new; page 2 (past 500 rows): g9's tag, a row with only its id.
        await writeGroup({ id: 'g9', name: 'Newcomer', members: [] });
        for (let i = 0; i < 510; i++) {
            await metadataDb.applyGroupChatStats(directories, 'g2', { sizeChange: 1, addedCreatedAt: i + 1, readLastCreatedAt: null });
        }
        expect(await metadataDb.assignEntityTag(directories, 'g9', 't1')).toBe('ok');
        recordFileReads();
        expect(await maintainer.tick()).toMatchObject({ changed: true, version: await metadataDb.getGroupsVersion(directories) });

        const favLookupsOfG9 = sqlEvents().filter(e => e.sql.startsWith(FAV_SQL_PREFIX) && e.args.flat().includes('g9'));
        expect(favLookupsOfG9).toHaveLength(2);
        expect(filesTagged('witchy')).toEqual(['g9.json']);
    }, 60000);
});

describe('tag renames', () => {
    test.each([
        ['saveTagDefinitions', () => metadataDb.saveTagDefinitions(directories, [{ id: 't1', name: 'spooky' }, { id: 't2', name: 'other' }])],
        ['editTagDefinition', () => metadataDb.editTagDefinition(directories, 't1', { name: 'spooky' })],
    ])('%s: no group_changes row; the tag-rename cursor re-reads the files of the groups carrying the tag', async (_name, rename) => {
        if (!tantivy) return;
        await saveTags();
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        await writeGroup({ id: 'g1', name: 'Copy', members: [] }, 'other.json');
        await writeGroup({ id: 'g2', name: 'Circle', members: [] });
        expect(await metadataDb.assignEntityTag(directories, 'g1', 't1')).toBe('ok');
        expect(await metadataDb.assignEntityTag(directories, 'g2', 't2')).toBe('ok');
        const maintainer = await builtMaintainer();
        expect(filesTagged('witchy')).toEqual(['g1.json', 'other.json']);

        const version = await metadataDb.getGroupsVersion(directories);
        await rename();
        expect(await metadataDb.getGroupsVersion(directories)).toBe(version);
        const renameSeq = await metadataDb.getCurrentTagNameChangeSeq(directories);
        expect(renameSeq).toBeGreaterThan(/** @type {number} */ (maintainer.tagNameSeq()));

        recordFileReads();
        expect(await maintainer.tick()).toMatchObject({ changed: true, refreshed: 2, version, tagNameSeq: renameSeq });
        expect(filesRead()).toEqual(['g1.json', 'other.json']);
        expect(filesTagged('spooky')).toEqual(['g1.json', 'other.json']);
        expect(filesTagged('witchy')).toEqual([]);
        expect(await metadataDb.getMetaValue(directories, TAG_NAME_SEQ_META_KEY)).toBe(String(renameSeq));
        expect(await maintainer.tick()).toBeNull();
    }, 30000);

    test('a tag delete with a merge target re-reads its groups under the target\'s name', async () => {
        if (!tantivy) return;
        await saveTags();
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        expect(await metadataDb.assignEntityTag(directories, 'g1', 't1')).toBe('ok');
        const maintainer = await builtMaintainer();
        const version = await metadataDb.getGroupsVersion(directories);

        expect(await metadataDb.deleteTagDefinition(directories, 't1', 't2')).toBe('ok');
        expect(await metadataDb.getGroupsVersion(directories)).toBe(version);
        expect(await maintainer.tick()).toMatchObject({ changed: true, refreshed: 1 });
        expect(filesTagged('witchy')).toEqual([]);
    }, 30000);
});

describe('full rebuilds', () => {
    test('a row with neither a group id nor a file name, as older versions logged, rebuilds in full', async () => {
        if (!tantivy) return;
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        const maintainer = await builtMaintainer();

        fs.writeFileSync(path.join(directories.groups, 'g2.json'), JSON.stringify({ id: 'g2', name: 'Unlogged', members: [] }));
        withRawDb(db => db.prepare('INSERT INTO group_changes (group_id, file_name) VALUES (NULL, NULL)').run());
        const result = await maintainer.tick();

        expect(result).toEqual({ swapped: path.join(directories.root, 'search-index', 'groups-tantivy') });
        expect(maintainer.version()).toBe(await metadataDb.getGroupsVersion(directories));
        expect(indexedDocs().map(d => d.fileName)).toEqual(['g1.json', 'g2.json']);
    }, 30000);

    test('the version log behind the index\'s version (an older database) rebuilds in full', async () => {
        if (!tantivy) return;
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        await writeGroup({ id: 'g2', name: 'Circle', members: [] });
        const maintainer = await builtMaintainer();

        withRawDb(db => db.prepare('DELETE FROM group_changes WHERE version = (SELECT MAX(version) FROM group_changes)').run());
        expect(await metadataDb.getGroupsVersion(directories)).toBeLessThan(/** @type {number} */ (maintainer.version()));
        expect(await maintainer.tick()).toHaveProperty('swapped');
        expect(maintainer.version()).toBe(await metadataDb.getGroupsVersion(directories));
    }, 30000);

    test('the tag-rename log behind the index\'s cursor rebuilds in full', async () => {
        if (!tantivy) return;
        await saveTags();
        await metadataDb.editTagDefinition(directories, 't1', { name: 'spooky' });
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        const maintainer = await builtMaintainer();
        expect(maintainer.tagNameSeq()).toBeGreaterThan(0);

        withRawDb(db => db.prepare('DELETE FROM tag_name_changes').run());
        expect(await maintainer.tick()).toHaveProperty('swapped');
        expect(maintainer.tagNameSeq()).toBe(0);
    }, 30000);

    test('nothing past the position is a no-op, not a rebuild', async () => {
        if (!tantivy) return;
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        const maintainer = await builtMaintainer();
        events.length = 0;

        expect(await maintainer.tick()).toBeNull();
        expect(sqlEvents().filter(e => /group_changes WHERE version >/.test(e.sql))).toEqual([]);
    }, 30000);
});

describe('position and persistence', () => {
    test('build and each catch-up persist the version and the tag-rename cursor the index covers', async () => {
        if (!tantivy) return;
        await saveTags();
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        const maintainer = await builtMaintainer();
        const meta = async () => [await metadataDb.getMetaValue(directories, VERSION_META_KEY), await metadataDb.getMetaValue(directories, TAG_NAME_SEQ_META_KEY)];

        expect(maintainer.version()).toBe(await metadataDb.getGroupsVersion(directories));
        expect(maintainer.tagNameSeq()).toBe(0);
        expect(await meta()).toEqual([String(maintainer.version()), '0']);

        await writeGroup({ id: 'g2', name: 'Circle', members: [] });
        await metadataDb.editTagDefinition(directories, 't2', { name: 'renamed' });
        await maintainer.tick();
        const version = await metadataDb.getGroupsVersion(directories);
        const tagNameSeq = await metadataDb.getCurrentTagNameChangeSeq(directories);
        expect([maintainer.version(), maintainer.tagNameSeq()]).toEqual([version, tagNameSeq]);
        expect(await meta()).toEqual([String(version), String(tagNameSeq)]);
    }, 30000);
});

describe('bounded reads', () => {
    test('the log is read in pages of at most 500 rows, and nothing reads with all', async () => {
        if (!tantivy) return;
        await writeGroup({ id: 'g1', name: 'Coven', members: [] });
        const maintainer = await builtMaintainer({ tickBudgetMs: 60000 });
        expect(sqlEvents().filter(e => e.method === 'all')).toEqual([]);

        for (let i = 0; i < 1100; i++) {
            await metadataDb.applyGroupChatStats(directories, 'g1', { sizeChange: 1, addedCreatedAt: i + 1, readLastCreatedAt: null });
        }
        events.length = 0;
        expect(await maintainer.tick()).toMatchObject({ changed: true, version: await metadataDb.getGroupsVersion(directories) });

        const sql = sqlEvents();
        expect(sql.filter(e => e.method === 'all')).toEqual([]);
        const pages = sql.filter(e => oneLine(e.sql) === GROUP_CHANGES_PAGE_SQL);
        expect(pages.map(e => e.method)).toEqual(['iterate', 'iterate', 'iterate']);
        expect(pages.map(e => e.args[0][1])).toEqual([501, 501, 501]);
        expect(indexedDocs().map(d => d.group.chat_size)).toEqual([1100]);
    }, 120000);
});
