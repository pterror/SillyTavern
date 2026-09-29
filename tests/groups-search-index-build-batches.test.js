import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';

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

const STATS_SQL_PREFIX = 'SELECT id, chat_size, date_last_chat FROM groups WHERE id IN (';
const FAV_SQL_PREFIX = 'SELECT id, fav FROM groups WHERE id IN (';
const GROUP_TAGS_SQL_PREFIX = 'SELECT group_id as entity_id, tag_id FROM group_tags WHERE group_id IN (';
const FILLER_COUNT = 1100;
const BATCH = 500;

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/groups.js')} */
let groupsModule;
/** @type {typeof import('../src/endpoints/groups-search-index.js')} */
let groupsSearchIndex;
/** @type {typeof import('../src/endpoints/tantivy-search.js')} */
let tantivySearch;
/** @type {any} */
let tantivy;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    groupsModule = await import('../src/endpoints/groups.js');
    groupsSearchIndex = await import('../src/endpoints/groups-search-index.js');
    tantivySearch = await import('../src/endpoints/tantivy-search.js');
    tantivy = await (await import('../src/endpoints/tantivy-engine.js')).getTantivyModule();
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-groups-search-index-build-batches-test-'));
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
});

afterEach(() => {
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/**
 * @param {string} fileName
 * @param {string} contents
 */
function writeGroupFile(fileName, contents) {
    fs.writeFileSync(path.join(directories.groups, fileName), contents);
}

/**
 * Seeds: `1001.json` (a row, fav, chat stats, tags alpha and beta with beta marked deleted), `other.json` holding id
 * 1002 (a row, tag alpha), `noid.json` with no id, `broken.json` that isn't JSON, `notes.txt`, and FILLER_COUNT
 * plain groups with no rows. gamma is assigned to nothing.
 */
async function seed() {
    expect(await metadataDb.saveTagDefinitions(directories, [
        { id: 't1', name: 'alpha' },
        { id: 't2', name: 'beta' },
        { id: 't3', name: 'gamma' },
    ])).toBe('ok');

    const coven = { id: '1001', name: 'Coven', members: ['witch.png', 'crone.png'], chats: ['c1'], chat_id: 'c1' };
    writeGroupFile('1001.json', JSON.stringify(coven));
    await metadataDb.upsertGroupRow(directories, '1001', 'Coven', { fav: true, group: coven });
    await metadataDb.applyGroupChatStats(directories, '1001', { sizeChange: 4321, addedCreatedAt: 8765, readLastCreatedAt: null });

    const elsewhere = { id: '1002', name: 'Elsewhere', members: ['nomad.png'], chats: [] };
    writeGroupFile('other.json', JSON.stringify(elsewhere));
    await metadataDb.upsertGroupRow(directories, '1002', 'Elsewhere', { fav: false, group: elsewhere });

    expect(await metadataDb.assignEntityTag(directories, '1001', 't1')).toBe('ok');
    expect(await metadataDb.assignEntityTag(directories, '1001', 't2')).toBe('ok');
    expect(await metadataDb.assignEntityTag(directories, '1002', 't1')).toBe('ok');
    expect(await metadataDb.deleteTagDefinition(directories, 't2')).toBe('ok');

    writeGroupFile('noid.json', JSON.stringify({ name: 'Nobody', members: ['ghost.png'], chats: [] }));
    writeGroupFile('broken.json', '{ not json');
    writeGroupFile('notes.txt', 'not a group');
    for (let i = 0; i < FILLER_COUNT; i++) {
        const id = String(5000 + i);
        writeGroupFile(`${id}.json`, JSON.stringify({ id, name: `Filler ${id}`, members: [], chats: [] }));
    }
}

/**
 * @param {any} index
 * @param {any} query
 * @returns {string[]} The DATA_FIELD of every doc the query matches.
 */
function matching(index, query) {
    const searcher = index.searcher();
    if (searcher.numDocs === 0) return [];
    const result = searcher.search(query, searcher.numDocs, true);
    return result.hits.map(hit => searcher.doc(hit.docAddress).getFirst(tantivySearch.DATA_FIELD));
}

/**
 * @param {any} index
 * @param {string} field
 * @param {string} term
 */
const byTerm = (index, field, term) => matching(index, tantivy.Query.termQuery(index.schema, field, term));

const sqlEvents = () => /** @type {{ kind: 'sql', method: string, sql: string, args: any[] }[]} */ (events.filter(e => e.kind === 'sql'));

describe('the groups index full build reads the groups folder in batches', () => {
    test('batches of at most 500 files, per-batch lookups only, every .json indexed as getGroupsData() reads it', async () => {
        if (!tantivy) return;
        await seed();
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const realReadFileSync = fs.readFileSync;
        jest.spyOn(fs, 'readFileSync').mockImplementation((/** @type {any} */ file, /** @type {any} */ ...rest) => {
            if (typeof file === 'string' && path.dirname(file) === directories.groups) {
                events.push({ kind: 'file', name: path.basename(file) });
            }
            return /** @type {any} */ (realReadFileSync)(file, ...rest);
        });
        events.length = 0;

        const maintainer = groupsSearchIndex.createGroupIndexMaintainer(directories, tantivy);
        const indexDir = await maintainer.build();
        const buildEvents = [...events];
        const buildSql = sqlEvents();

        // No `all`, and no read of the whole tag list: every tags read asks for the batch's assigned ids only.
        expect(buildSql.filter(e => e.method === 'all')).toEqual([]);
        const tagReads = buildSql.filter(e => /\bFROM tags\b/.test(e.sql));
        expect(tagReads.length).toBeGreaterThan(0);
        for (const read of tagReads) {
            expect(read.sql).toContain('WHERE id IN (');
            expect(read.args[0].every(id => id === 't1' || id === 't2')).toBe(true);
        }

        // Every .json (not notes.txt) is read once, in three batches: each batch's lookups come after its own
        // files are read and before the next batch's.
        const jsonCount = FILLER_COUNT + 4;
        const fileNames = buildEvents.filter(e => e.kind === 'file').map(e => /** @type {any} */ (e).name);
        expect(fileNames.length).toBe(jsonCount);
        expect(new Set(fileNames).size).toBe(jsonCount);
        expect(fileNames).not.toContain('notes.txt');
        let filesSoFar = 0;
        /** @type {Record<string, number[]>} */
        const filesReadAt = { stats: [], fav: [], groupTags: [] };
        for (const event of buildEvents) {
            if (event.kind === 'file') {
                filesSoFar++;
                continue;
            }
            if (event.sql.startsWith(STATS_SQL_PREFIX)) filesReadAt.stats.push(filesSoFar);
            if (event.sql.startsWith(FAV_SQL_PREFIX)) filesReadAt.fav.push(filesSoFar);
            if (event.sql.startsWith(GROUP_TAGS_SQL_PREFIX)) filesReadAt.groupTags.push(filesSoFar);
        }
        const batchEnds = [BATCH, 2 * BATCH, jsonCount];
        expect(filesReadAt.stats).toEqual(batchEnds);
        expect(filesReadAt.fav).toEqual(batchEnds);
        expect(filesReadAt.groupTags).toEqual(batchEnds);
        for (const read of buildSql.filter(e => [STATS_SQL_PREFIX, FAV_SQL_PREFIX, GROUP_TAGS_SQL_PREFIX].some(prefix => e.sql.startsWith(prefix)))) {
            expect(read.args[0].length).toBeLessThanOrEqual(BATCH);
        }

        // The broken file is logged and skipped.
        expect(errorSpy.mock.calls.some(call => call[0] instanceof SyntaxError)).toBe(true);

        const index = tantivy.Index.open(indexDir);
        index.reload();
        expect(index.searcher().numDocs).toBe(jsonCount - 1);

        // Each doc's stored JSON is getGroupsData()'s group for its file, with fav added, byte for byte.
        const expectedByName = new Map((await groupsModule.getGroupsData(directories)).map(group => [group.name, group]));
        const favs = { Coven: true };
        /** @param {string} name */
        const expectedRaw = (name) => JSON.stringify({ ...expectedByName.get(name), fav: !!favs[name] });
        const all = matching(index, tantivy.Query.allQuery());
        expect(all.length).toBe(jsonCount - 1);
        for (const raw of all) {
            expect(raw).toBe(expectedRaw(JSON.parse(raw).name));
        }
        const coven = JSON.parse(expectedRaw('Coven'));
        expect([coven.chat_size, coven.date_last_chat, coven.fav]).toEqual([4321, 8765, true]);

        // The file-name field holds each file's name, including a file not named <id>.json and a file with no id.
        expect(byTerm(index, 'file_name', '1001.json')).toEqual([expectedRaw('Coven')]);
        expect(byTerm(index, 'file_name', 'other.json')).toEqual([expectedRaw('Elsewhere')]);
        expect(byTerm(index, 'file_name', 'noid.json')).toEqual([expectedRaw('Nobody')]);
        expect(byTerm(index, 'file_name', '5000.json')).toEqual([expectedRaw('Filler 5000')]);
        expect(byTerm(index, 'file_name', 'broken.json')).toEqual([]);
        expect(byTerm(index, 'file_name', 'other')).toEqual([]);

        // The id field holds the id inside the file, untokenized; a file with no id has none.
        expect(byTerm(index, 'group_id', '1002')).toEqual([expectedRaw('Elsewhere')]);
        expect(byTerm(index, 'group_id', '1001')).toEqual([expectedRaw('Coven')]);
        expect(byTerm(index, 'group_id', '')).toEqual([]);
        expect(byTerm(index, 'group_id', 'other.json')).toEqual([]);

        // Searchable content: names, members, the id, and tag names resolved without the deleted tag.
        expect(byTerm(index, 'name', 'coven')).toEqual([expectedRaw('Coven')]);
        expect(byTerm(index, 'name', 'nobody')).toEqual([expectedRaw('Nobody')]);
        expect(byTerm(index, 'members', 'crone')).toEqual([expectedRaw('Coven')]);
        expect(byTerm(index, 'members', 'ghost')).toEqual([expectedRaw('Nobody')]);
        expect(byTerm(index, 'id', '1002')).toEqual([expectedRaw('Elsewhere')]);
        expect(byTerm(index, 'resolved_tags', 'alpha').sort()).toEqual([expectedRaw('Coven'), expectedRaw('Elsewhere')].sort());
        expect(byTerm(index, 'resolved_tags', 'beta')).toEqual([]);
        expect(byTerm(index, 'resolved_tags', 'gamma')).toEqual([]);
        expect(byTerm(index, 'tag_ids', 't1').sort()).toEqual([expectedRaw('Coven'), expectedRaw('Elsewhere')].sort());
        expect(matching(index, tantivy.Query.termQuery(index.schema, tantivySearch.FAV_FIELD, true))).toEqual([expectedRaw('Coven')]);

        // Search results show the id inside the file.
        const ids = matching(index, tantivy.Query.termQuery(index.schema, 'file_name', 'other.json')).map(raw => JSON.parse(raw).id);
        expect(ids).toEqual(['1002']);
    }, 60000);

    test('an empty groups folder builds an empty index with no group reads', async () => {
        if (!tantivy) return;
        await metadataDb.saveTagDefinitions(directories, [{ id: 't1', name: 'alpha' }]);
        events.length = 0;

        const maintainer = groupsSearchIndex.createGroupIndexMaintainer(directories, tantivy);
        const index = tantivy.Index.open(await maintainer.build());
        index.reload();
        expect(index.searcher().numDocs).toBe(0);
        const buildSql = sqlEvents();
        expect(buildSql.filter(e => e.method === 'all')).toEqual([]);
        expect(buildSql.filter(e => /\bFROM (tags|group_tags)\b/.test(e.sql) || e.sql.startsWith(STATS_SQL_PREFIX) || e.sql.startsWith(FAV_SQL_PREFIX))).toEqual([]);
    }, 30000);
});
