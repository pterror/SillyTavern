import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { insertTagRowRaw } from './util/stored-counters.js';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/** While armed, the transaction call with this 1-based number throws instead of running. */
let crashAtTransaction = 0;
let transactionCalls = 0;
/** @type {string[]} The SQL of every write made through the store's handle. */
let runSql = [];
/** @type {(() => void) | null} Called after each transaction of the store's handle commits. */
let afterCommit = null;

/** @param {any} handle */
function instrumentedHandle(handle) {
    const wrapped = { ...handle };
    wrapped.transaction = (fn) => {
        transactionCalls++;
        if (crashAtTransaction && transactionCalls === crashAtTransaction) throw new Error('simulated stop');
        const result = handle.transaction(fn);
        afterCommit?.();
        return result;
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tag-derived-columns-fill-test-'));
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
    afterCommit = null;
});

/** @type {import('better-sqlite3').Database | null} A second connection standing in for the server's live writes. */
let liveDb = null;
function live() {
    liveDb ??= new Database(path.join(directories.root, 'character-metadata.sqlite'));
    return liveDb;
}

afterEach(() => {
    jest.restoreAllMocks();
    liveDb?.close();
    liveDb = null;
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

const QUERY_INDEXES = [
    'CREATE INDEX tags_folder_name_key ON tags(is_folder, name_key)',
    'CREATE INDEX tags_folder_sort_order ON tags(is_folder, sort_order)',
    'CREATE INDEX tags_folder_unordered_name_key ON tags(is_folder, name_key) WHERE sort_order IS NULL',
    'CREATE INDEX tags_folder_usage_count ON tags(is_folder, usage_count DESC, name_key)',
    'CREATE INDEX tags_name_key ON tags(name_key)',
    'CREATE INDEX tags_sort_order ON tags(sort_order)',
    'CREATE INDEX tags_unordered_name_key ON tags(name_key) WHERE sort_order IS NULL',
    'CREATE INDEX tags_usage_count ON tags(usage_count DESC, name_key)',
    'CREATE INDEX tags_used_name_key ON tags(name_key) WHERE usage_count > 0',
    'CREATE INDEX tags_used_sort_order ON tags(sort_order) WHERE usage_count > 0',
    'CREATE INDEX tags_used_unordered_name_key ON tags(name_key) WHERE sort_order IS NULL AND usage_count > 0',
];

/** The CREATE statements of the indexes on tags, beside its primary key's. */
function tagIndexes() {
    return [...live().prepare('SELECT sql FROM sqlite_master WHERE type = \'index\' AND tbl_name = \'tags\' AND sql IS NOT NULL ORDER BY name').pluck().iterate()];
}

/** @param {number} i */
const tagId = i => `t${String(i).padStart(5, '0')}`;

/**
 * A tag's data by index: every sort_order and folder_type form the coercion covers, some unparseable.
 * @param {number} i
 */
function tagData(i) {
    if (i % 97 === 0) return '{not json';
    const tag = { id: tagId(i), name: `Tag ${i}` };
    const order = [undefined, null, i, String(i), 'abc', { at: i }, true][i % 7];
    if (order !== undefined) tag.sort_order = order;
    const folder = [undefined, 'NONE', 'OPEN', null, 3][i % 5];
    if (folder !== undefined) tag.folder_type = folder;
    return JSON.stringify(tag);
}

/**
 * Writes `count` tags rows as a store from before the derived columns wrote them (NULL there), and tag_usage rows:
 * some tags assigned, some at count 0, some with no row.
 * @param {number} count
 */
async function seedOldTags(count) {
    await metadataDb.ensureSchemaMigrated(directories);
    const db = live();
    const insertTag = db.prepare('INSERT INTO tags (id, data, name_key) VALUES (?, ?, ?)');
    const insertUsage = db.prepare('INSERT INTO tag_usage (tag_id, count) VALUES (?, ?)');
    db.transaction(() => {
        for (let i = 0; i < count; i++) {
            insertTag.run(tagId(i), tagData(i), `tag ${i}`);
            if (i % 3 === 0) insertUsage.run(tagId(i), i % 11);
        }
    })();
}

/** Every tags row whose columns differ from its data's derivation and its tag_usage.count, as [id, stored, expected]. */
function mismatches() {
    const rows = live().prepare(`SELECT t.id, t.data, t.sort_order, t.folder_type, t.is_folder, t.usage_count, u.count
        FROM tags t LEFT JOIN tag_usage u ON u.tag_id = t.id ORDER BY t.rowid`).iterate();
    const out = [];
    for (const row of rows) {
        let tag = null;
        try {
            tag = JSON.parse(row.data);
        } catch {
            // Derived as data with no fields.
        }
        const { sortOrder, folderType, isFolder } = metadataDb.tagDerivedColumns(tag);
        const expected = { sort_order: sortOrder, folder_type: folderType, is_folder: isFolder, usage_count: row.count ?? 0 };
        const stored = { sort_order: row.sort_order, folder_type: row.folder_type, is_folder: row.is_folder, usage_count: row.usage_count };
        if (JSON.stringify(stored) !== JSON.stringify(expected)) out.push([row.id, stored, expected]);
    }
    return out;
}

/** @param {string} key */
function metaValue(key) {
    return live().prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key);
}

const FLAG = 'tag_derived_columns_filled_v1';
const UPTO = `${FLAG}_upto`;

describe('fillTagDerivedColumnsIfNeeded', () => {
    test('opening a store builds none of the query indexes; the fill builds exactly them', async () => {
        await metadataDb.ensureSchemaMigrated(directories);
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        expect(tagIndexes()).toEqual(['CREATE INDEX tags_name_key ON tags(name_key)']);
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        expect(tagIndexes()).toEqual(QUERY_INDEXES);
    });

    test('a store filled before an index was added gets it from the next run', async () => {
        await metadataDb.ensureSchemaMigrated(directories);
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        live().exec('DROP INDEX tags_folder_usage_count');
        expect(tagIndexes()).not.toContain('CREATE INDEX tags_folder_usage_count ON tags(is_folder, usage_count DESC, name_key)');
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        expect(tagIndexes()).toEqual(QUERY_INDEXES);
    });

    test('fills every row across batches, marks the fill done and drops the frontier', async () => {
        await seedOldTags(2500);
        expect(mismatches()).toHaveLength(2500);
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        expect(result).toEqual({ batches: 3, rowsChanged: 2500 });
        expect(mismatches()).toEqual([]);
        expect(metaValue(FLAG)).toBeDefined();
        expect(metaValue(UPTO)).toBeUndefined();
        // The seed reaches every form: ordered and unordered, folders and not, used, count 0 and no tag_usage row.
        const counts = live().prepare(`SELECT SUM(sort_order IS NULL) AS unordered, SUM(is_folder) AS folders,
            SUM(usage_count > 0) AS used, SUM(usage_count = 0) AS unused FROM tags`).get();
        for (const n of Object.values(counts)) expect(n).toBeGreaterThan(0);
    });

    test('an empty store is marked done in one batch', async () => {
        await metadataDb.ensureSchemaMigrated(directories);
        expect(await metadataDb.fillTagDerivedColumnsIfNeeded(directories)).toEqual({ batches: 1, rowsChanged: 0 });
        expect(metaValue(FLAG)).toBeDefined();
    });

    test('rows whose columns are already right are not written', async () => {
        await metadataDb.ensureSchemaMigrated(directories);
        await metadataDb.saveTagDefinitions(directories, [{ id: 'a', name: 'A', sort_order: 2 }, { id: 'b', name: 'B', folder_type: 'OPEN' }]);
        expect(await metadataDb.fillTagDerivedColumnsIfNeeded(directories)).toEqual({ batches: 1, rowsChanged: 0 });
        expect(mismatches()).toEqual([]);
    });

    test('logs each tag whose sort_order has no order once, with its raw value', async () => {
        await seedOldTags(20);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        const logged = warn.mock.calls.map(args => String(args[0])).join('\n');
        const lines = logged.split('\n').filter(line => line.startsWith('  '));
        expect(lines).toEqual([
            '  t00004 (Tag 4): "abc"',
            '  t00005 (Tag 5): {"at":5}',
            '  t00011 (Tag 11): "abc"',
            '  t00012 (Tag 12): {"at":12}',
            '  t00018 (Tag 18): "abc"',
            '  t00019 (Tag 19): {"at":19}',
        ]);
        warn.mockClear();
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        expect(warn).not.toHaveBeenCalled();
    });

    test('an interrupted fill resumes from its frontier, and logs each tag only in the page that committed', async () => {
        await seedOldTags(2500);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        transactionCalls = 0;
        crashAtTransaction = 2;
        await expect(metadataDb.fillTagDerivedColumnsIfNeeded(directories)).rejects.toThrow('simulated stop');
        crashAtTransaction = 0;
        const firstRowids = live().prepare('SELECT rowid FROM tags ORDER BY rowid LIMIT 1000').pluck().iterate();
        let last = null;
        for (const rowid of firstRowids) last = rowid;
        expect(metaValue(UPTO)).toBe(String(last));
        expect(metaValue(FLAG)).toBeUndefined();
        expect(mismatches()).toHaveLength(1500);
        const loggedFirst = warn.mock.calls.flatMap(args => String(args[0]).split('\n').filter(line => line.startsWith('  ')));

        metadataDb.disposeMetadataStores();
        warn.mockClear();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        expect(await metadataDb.fillTagDerivedColumnsIfNeeded(directories)).toEqual({ batches: 2, rowsChanged: 1500 });
        expect(mismatches()).toEqual([]);
        const loggedSecond = warn.mock.calls.flatMap(args => String(args[0]).split('\n').filter(line => line.startsWith('  ')));
        expect(loggedFirst.filter(line => loggedSecond.includes(line))).toEqual([]);
        const unordered = [...Array(2500).keys()].filter(i => i % 97 !== 0 && (i % 7 === 4 || i % 7 === 5));
        expect(loggedFirst.length + loggedSecond.length).toBe(unordered.length);
    });

    test('live writes between batches leave every row right at the end', async () => {
        await seedOldTags(2500);
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        await metadataDb.upsertCharacterFromWrite(directories, 'a.png', JSON.stringify({ name: 'a', spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'a', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } }));
        let round = 0;
        afterCommit = () => {
            round++;
            const db = live();
            // An assignment to a row the fill has passed and to one it hasn't: the triggers set usage_count.
            insertTagRowRaw(db, 'character_tags', 'a.png', tagId(round));
            insertTagRowRaw(db, 'character_tags', 'a.png', tagId(2400 - round));
        };
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        afterCommit = null;
        expect(round).toBeGreaterThanOrEqual(3);
        expect(mismatches()).toEqual([]);
    });

    test('a finished store writes nothing and runs no transaction on the next run', async () => {
        await seedOldTags(10);
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        runSql = [];
        transactionCalls = 0;
        expect(await metadataDb.fillTagDerivedColumnsIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });
        expect(runSql).toEqual([]);
        expect(transactionCalls).toBe(0);
    });

    test('runs right after fillTagNameKeysIfNeeded in MIGRATION_PASSES', async () => {
        const { MIGRATION_PASSES } = await import('../src/metadata-migration-coordinator.js');
        expect(MIGRATION_PASSES[MIGRATION_PASSES.indexOf('fillTagDerivedColumnsIfNeeded') - 1]).toBe('fillTagNameKeysIfNeeded');
    });
});

describe('areTagQueryColumnsReady', () => {
    beforeEach(() => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    test('true only once the derived columns fill and name_key\'s fill are both done', async () => {
        await seedOldTags(5);
        expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(false);
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        // name_key's index is not built yet.
        expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(false);
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        live().prepare('UPDATE tags SET name_key = NULL WHERE id = ?').run(tagId(0));
        expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(false);
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(true);
    });

    test('false while the fill has a frontier short of the end', async () => {
        await seedOldTags(1500);
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        crashAtTransaction = transactionCalls + 2;
        await expect(metadataDb.fillTagDerivedColumnsIfNeeded(directories)).rejects.toThrow('simulated stop');
        crashAtTransaction = 0;
        expect(metaValue(UPTO)).toBeDefined();
        expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(false);
    });
});
