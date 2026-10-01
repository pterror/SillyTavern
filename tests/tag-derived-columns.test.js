import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('better-sqlite3')} */
let Database;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/** Every statement the store's handle read through get() or iterate(), while recording. */
let recording = false;
/** @type {{ sql: string, params: any }[]} */
let recorded = [];

/** @param {any} handle */
function instrumentedHandle(handle) {
    const wrapped = { ...handle };
    wrapped.get = (sql, params) => {
        if (recording) recorded.push({ sql, params });
        return handle.get(sql, params);
    };
    wrapped.iterate = function* (sql, params) {
        if (recording) recorded.push({ sql, params });
        yield* handle.iterate(sql, params);
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tag-derived-columns-test-'));
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
});

afterEach(() => {
    jest.restoreAllMocks();
    recording = false;
    recorded = [];
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

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

/**
 * @param {string} id
 * @returns {{ sort_order: number | null, folder_type: string | null, is_folder: number | null, usage_count: number | null } | undefined}
 */
function derived(id) {
    return withRawDb(db => db.prepare('SELECT sort_order, folder_type, is_folder, usage_count FROM tags WHERE id = ?').get(id));
}

/** @param {string} id */
function usageCount(id) {
    return withRawDb(db => /** @type {{ count: number } | undefined} */ (db.prepare('SELECT count FROM tag_usage WHERE tag_id = ?').get(id))?.count);
}

/** Opens the store, which creates and migrates the schema. */
async function openStore() {
    await metadataDb.getTagUsageCount(directories, 'none');
}

function card(name) {
    return JSON.stringify({ name, spec: 'chara_card_v2', spec_version: '2.0', data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
}

/** @param {string} id */
async function seedCharacter(id) {
    await metadataDb.upsertCharacterFromWrite(directories, id, card(id.replace(/\.png$/, '')));
}

/** @param {string} id */
async function seedGroup(id) {
    const group = { id, name: id, members: [], chats: [], fav: false };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, id, { fav: false, group });
}

describe('tagDerivedColumns', () => {
    const sortOrderOf = (/** @type {unknown} */ value) => metadataDb.tagDerivedColumns({ id: 't', sort_order: value }).sortOrder;
    const folderOf = (/** @type {unknown} */ value) => {
        const { folderType, isFolder } = metadataDb.tagDerivedColumns({ id: 't', folder_type: value });
        return [folderType, isFolder];
    };

    test('sort_order: numbers as they are, missing is no order, null is 0', () => {
        expect(metadataDb.tagDerivedColumns({ id: 't' }).sortOrder).toBeNull();
        expect(sortOrderOf(undefined)).toBeNull();
        expect(sortOrderOf(null)).toBe(0);
        expect(sortOrderOf(3)).toBe(3);
        expect(sortOrderOf(-1.5)).toBe(-1.5);
        expect(sortOrderOf(Infinity)).toBe(Infinity);
    });

    test('sort_order: strings and booleans coerce as Number() does, NaN and objects are no order', () => {
        expect(sortOrderOf('5')).toBe(5);
        expect(sortOrderOf('')).toBe(0);
        expect(sortOrderOf('  ')).toBe(0);
        expect(sortOrderOf('0x1A')).toBe(26);
        expect(sortOrderOf('1e3')).toBe(1000);
        expect(sortOrderOf('Infinity')).toBe(Infinity);
        expect(sortOrderOf(true)).toBe(1);
        expect(sortOrderOf(false)).toBe(0);
        expect(sortOrderOf('abc')).toBeNull();
        expect(sortOrderOf(NaN)).toBeNull();
        expect(sortOrderOf({})).toBeNull();
        expect(sortOrderOf([5])).toBeNull();
    });

    test('folder_type: missing is NONE, strings as they are, anything else JSON; a folder is anything but NONE', () => {
        expect(metadataDb.tagDerivedColumns({ id: 't' })).toMatchObject({ folderType: 'NONE', isFolder: 0 });
        expect(folderOf(undefined)).toEqual(['NONE', 0]);
        expect(folderOf('NONE')).toEqual(['NONE', 0]);
        expect(folderOf('OPEN')).toEqual(['OPEN', 1]);
        expect(folderOf('none')).toEqual(['none', 1]);
        expect(folderOf('')).toEqual(['', 1]);
        expect(folderOf(null)).toEqual(['null', 1]);
        expect(folderOf(5)).toEqual(['5', 1]);
        expect(folderOf(false)).toEqual(['false', 1]);
        expect(folderOf({ a: 1 })).toEqual(['{"a":1}', 1]);
    });

    test('data that is not an object derives as if every field were missing', () => {
        expect(metadataDb.tagDerivedColumns(null)).toEqual({ sortOrder: null, folderType: 'NONE', isFolder: 0 });
        expect(metadataDb.tagDerivedColumns('x')).toEqual({ sortOrder: null, folderType: 'NONE', isFolder: 0 });
    });
});

describe('columns at open', () => {
    test('a new store has the four columns, typed, with no defaults', async () => {
        await openStore();
        const columns = withRawDb(db => [...db.prepare('PRAGMA table_info(tags)').iterate()]);
        const byName = new Map(columns.map(c => [c.name, c]));
        expect(byName.get('sort_order')).toMatchObject({ type: 'REAL', dflt_value: null, notnull: 0 });
        expect(byName.get('folder_type')).toMatchObject({ type: 'TEXT', dflt_value: null, notnull: 0 });
        expect(byName.get('is_folder')).toMatchObject({ type: 'INTEGER', dflt_value: null, notnull: 0 });
        expect(byName.get('usage_count')).toMatchObject({ type: 'INTEGER', dflt_value: null, notnull: 0 });
    });

    test('an old store gets the columns (NULL on its rows) and the new trigger bodies, and a later open writes no schema', async () => {
        await openStore();
        const newTriggers = withRawDb(db => [...db.prepare('SELECT name, sql FROM sqlite_master WHERE type = \'trigger\' AND name IN (\'trg_character_tags_ai\', \'trg_character_tags_ad\', \'trg_group_tags_ai\', \'trg_group_tags_ad\') ORDER BY name').iterate()]);
        expect(newTriggers).toHaveLength(4);
        metadataDb.disposeMetadataStores();

        withRawDb(db => {
            for (const name of ['sort_order', 'folder_type', 'is_folder', 'usage_count']) db.exec(`ALTER TABLE tags DROP COLUMN ${name}`);
            for (const { name } of newTriggers) db.exec(`DROP TRIGGER ${name}`);
            db.exec(`
                CREATE TRIGGER IF NOT EXISTS trg_character_tags_ai AFTER INSERT ON character_tags BEGIN
                    INSERT INTO tag_usage (tag_id, count) VALUES (NEW.tag_id, 1)
                    ON CONFLICT(tag_id) DO UPDATE SET count = count + 1;
                END;
                CREATE TRIGGER IF NOT EXISTS trg_character_tags_ad AFTER DELETE ON character_tags BEGIN
                    UPDATE tag_usage SET count = count - 1 WHERE tag_id = OLD.tag_id;
                END;
                CREATE TRIGGER IF NOT EXISTS trg_group_tags_ai AFTER INSERT ON group_tags BEGIN
                    INSERT INTO tag_usage (tag_id, count) VALUES (NEW.tag_id, 1)
                    ON CONFLICT(tag_id) DO UPDATE SET count = count + 1;
                END;
                CREATE TRIGGER IF NOT EXISTS trg_group_tags_ad AFTER DELETE ON group_tags BEGIN
                    UPDATE tag_usage SET count = count - 1 WHERE tag_id = OLD.tag_id;
                END;
            `);
            db.prepare('INSERT INTO tags (id, data, name_key) VALUES (?, ?, ?)').run('old', JSON.stringify({ id: 'old', name: 'Old', sort_order: 4 }), 'old');
            db.prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)').run('a.png', 'old');
        });

        await openStore();
        expect(derived('old')).toEqual({ sort_order: null, folder_type: null, is_folder: null, usage_count: null });
        const migrated = withRawDb(db => [...db.prepare('SELECT name, sql FROM sqlite_master WHERE type = \'trigger\' AND name IN (\'trg_character_tags_ai\', \'trg_character_tags_ad\', \'trg_group_tags_ai\', \'trg_group_tags_ad\') ORDER BY name').iterate()]);
        expect(migrated).toEqual(newTriggers);

        // The new body sets usage_count from tag_usage, so an unfilled row gets its exact count, not NULL + 1.
        await seedCharacter('b.png');
        expect(await metadataDb.assignEntityTag(directories, 'b.png', 'old')).toBe('ok');
        expect(usageCount('old')).toBe(2);
        expect(derived('old')?.usage_count).toBe(2);

        metadataDb.disposeMetadataStores();
        const schemaVersion = () => withRawDb(db => db.pragma('schema_version', { simple: true }));
        const before = schemaVersion();
        await openStore();
        expect(schemaVersion()).toBe(before);
    });
});

describe('every tags write sets the derived columns with data', () => {
    test('saveTagDefinitions', async () => {
        await openStore();
        await metadataDb.saveTagDefinitions(directories, [
            { id: 'a', name: 'A', sort_order: '7', folder_type: 'OPEN' },
            { id: 'b', name: 'B' },
        ]);
        expect(derived('a')).toEqual({ sort_order: 7, folder_type: 'OPEN', is_folder: 1, usage_count: 0 });
        expect(derived('b')).toEqual({ sort_order: null, folder_type: 'NONE', is_folder: 0, usage_count: 0 });
    });

    test('createTagDefinition, and editTagDefinition on update', async () => {
        await openStore();
        // Until the sort_order fill has finished, a given sort_order is queued rather than written.
        await makeReady();
        await metadataDb.migrateTagsJsonIfNeeded(directories);
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A', sort_order: null, folder_type: null });
        expect(derived('a')).toEqual({ sort_order: 0, folder_type: 'null', is_folder: 1, usage_count: 0 });
        await metadataDb.editTagDefinition(directories, 'a', { sort_order: 2.5, folder_type: 'NONE' });
        expect(derived('a')).toEqual({ sort_order: 2.5, folder_type: 'NONE', is_folder: 0, usage_count: 0 });
        await metadataDb.editTagDefinition(directories, 'a', { sort_order: 'abc', folder_type: 'OPEN' });
        expect(derived('a')).toEqual({ sort_order: null, folder_type: 'OPEN', is_folder: 1, usage_count: 0 });
    });

    test('migrateTagsJsonIfNeeded', async () => {
        await openStore();
        fs.writeFileSync(path.join(directories.root, 'tags.json'), JSON.stringify({
            tags: [{ id: 'j', name: 'J', sort_order: true, folder_type: 'CLOSED' }],
            tag_map: {},
        }));
        await metadataDb.migrateTagsJsonIfNeeded(directories);
        expect(derived('j')).toEqual({ sort_order: 1, folder_type: 'CLOSED', is_folder: 1, usage_count: 0 });
    });

    test('card tag creation', async () => {
        await openStore();
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        const name = 'Brand New';
        const json = JSON.stringify({ name: 'Bob', spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Bob', tags: [name], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', json);
        const { tagIds } = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');
        expect(tagIds).toHaveLength(1);
        expect(usageCount(tagIds[0])).toBe(1);
        expect(derived(tagIds[0])).toEqual({ sort_order: 1, folder_type: 'NONE', is_folder: 0, usage_count: 1 });
    });

    test('usage_count at write is the id\'s tag_usage.count when assignments came first', async () => {
        await openStore();
        await seedCharacter('a.png');
        await seedGroup('g1');
        expect(await metadataDb.assignEntityTag(directories, 'a.png', 'early')).toBe('ok');
        expect(await metadataDb.assignEntityTag(directories, 'g1', 'early')).toBe('ok');
        expect(await metadataDb.unassignEntityTag(directories, 'g1', 'early')).toBe('ok');
        expect(await metadataDb.assignEntityTag(directories, 'g1', 'zero')).toBe('ok');
        expect(await metadataDb.unassignEntityTag(directories, 'g1', 'zero')).toBe('ok');
        expect(usageCount('early')).toBe(1);
        expect(usageCount('zero')).toBe(0);

        await metadataDb.createTagDefinition(directories, { id: 'early', name: 'Early' });
        await metadataDb.saveTagDefinitions(directories, [{ id: 'early', name: 'Early' }, { id: 'zero', name: 'Zero' }]);
        expect(derived('early')?.usage_count).toBe(1);
        expect(derived('zero')?.usage_count).toBe(0);
    });
});

describe('the tag_usage triggers keep usage_count equal to tag_usage.count', () => {
    test('character and group assigns and unassigns', async () => {
        await openStore();
        await metadataDb.saveTagDefinitions(directories, [{ id: 't', name: 'T' }, { id: 'u', name: 'U' }]);
        await seedCharacter('a.png');
        await seedCharacter('b.png');
        await seedGroup('g1');

        const check = (/** @type {number} */ expected) => {
            expect(usageCount('t')).toBe(expected);
            expect(derived('t')?.usage_count).toBe(expected);
            expect(derived('u')?.usage_count).toBe(0);
        };
        expect(await metadataDb.assignEntityTag(directories, 'a.png', 't')).toBe('ok');
        check(1);
        expect(await metadataDb.assignEntityTag(directories, 'b.png', 't')).toBe('ok');
        check(2);
        expect(await metadataDb.assignEntityTag(directories, 'g1', 't')).toBe('ok');
        check(3);
        expect(await metadataDb.unassignEntityTag(directories, 'a.png', 't')).toBe('ok');
        check(2);
        expect(await metadataDb.unassignEntityTag(directories, 'g1', 't')).toBe('ok');
        check(1);
        expect(await metadataDb.unassignEntityTag(directories, 'b.png', 't')).toBe('ok');
        check(0);
    });
});

/** @param {string} id @returns {unknown} the stored data, parsed, or undefined without a row */
function storedData(id) {
    const row = withRawDb(db => /** @type {{ data: string } | undefined} */ (db.prepare('SELECT data FROM tags WHERE id = ?').get(id)));
    return row === undefined ? undefined : JSON.parse(row.data);
}

/**
 * A connection that stays open, so its data_version moves exactly when the store commits a write.
 * @returns {{ changed: () => boolean, close: () => void }}
 */
function watchWrites() {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    const version = () => db.pragma('data_version', { simple: true });
    const before = version();
    return { changed: () => version() !== before, close: () => db.close() };
}

async function makeReady() {
    await metadataDb.fillTagNameKeysIfNeeded(directories);
    await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
    expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(true);
}

/** @param {string} sql */
const readsTags = sql => /\bFROM tags\b/.test(sql);

/** @param {{ sql: string, params: any }} statement */
function planOf({ sql, params }) {
    return withRawDb(db => {
        const explain = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
        return (params === undefined ? Array.from(explain.iterate()) : Array.from(explain.iterate(params))).map(row => row.detail).join(' | ');
    });
}

describe('createTagDefinition', () => {
    test('an id that already has a row is refused as exists, and nothing is written', async () => {
        await openStore();
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        expect(await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A' })).toEqual({ refused: [], tag: { id: 'a', name: 'A', sort_order: 1 } });
        const watcher = watchWrites();
        try {
            expect(await metadataDb.createTagDefinition(directories, { id: 'a', name: 'Other', sort_order: 9 })).toEqual({ refused: [{ id: 'a', reason: 'exists' }] });
            expect(watcher.changed()).toBe(false);
        } finally {
            watcher.close();
        }
        expect(storedData('a')).toEqual({ id: 'a', name: 'A', sort_order: 1 });
    });

    test('a marked id is refused as deleted, before exists, with a warning naming it, and nothing is written', async () => {
        await openStore();
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A' });
        await metadataDb.createTagDefinition(directories, { id: 'b', name: 'B' });
        await metadataDb.deleteTagDefinition(directories, 'a', null);
        withRawDb(db => db.prepare('DELETE FROM tags WHERE id = ?').run('b'));
        withRawDb(db => db.prepare('INSERT INTO tag_deletions (tag_id, merge_into) VALUES (?, NULL)').run('b'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const watcher = watchWrites();
        try {
            expect(await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A2' })).toEqual({ refused: [{ id: 'a', reason: 'deleted' }] });
            expect(await metadataDb.createTagDefinition(directories, { id: 'b', name: 'B2' })).toEqual({ refused: [{ id: 'b', reason: 'deleted' }] });
            expect(watcher.changed()).toBe(false);
        } finally {
            watcher.close();
        }
        expect(storedData('a')).toEqual({ id: 'a', name: 'A', sort_order: 1 });
        expect(storedData('b')).toBeUndefined();
        const messages = warn.mock.calls.map(args => args.join(' '));
        expect(messages.some(m => m.includes('a'))).toBe(true);
        expect(messages.some(m => m.includes('b'))).toBe(true);
    });

    test('a given sort_order is kept as given, null included', async () => {
        await openStore();
        await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A', sort_order: 7 });
        await metadataDb.createTagDefinition(directories, { id: 'b', name: 'B', sort_order: null });
        await metadataDb.createTagDefinition(directories, { id: 'c', name: 'C', sort_order: -3 });
        expect(storedData('a')).toEqual({ id: 'a', name: 'A', sort_order: 7 });
        expect(storedData('b')).toEqual({ id: 'b', name: 'B', sort_order: null });
        expect(storedData('c')).toEqual({ id: 'c', name: 'C', sort_order: -3 });
        expect(derived('a')?.sort_order).toBe(7);
        expect(derived('b')?.sort_order).toBe(0);
        expect(derived('c')?.sort_order).toBe(-3);
    });

    describe('with no sort_order, max+1, after the fill', () => {
        const ready = true;
        beforeEach(async () => {
            await openStore();
            await makeReady();
        });

        /** @param {string} id @returns {unknown} */
        const orderOf = id => /** @type {any} */ (storedData(id)).sort_order;

        test('an empty table gives 1, in data and in the column', async () => {
            expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(ready);
            await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A' });
            expect(orderOf('a')).toBe(1);
            expect(derived('a')?.sort_order).toBe(1);
        });

        test('tags with no order don\'t count', async () => {
            await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A', sort_order: 3 });
            await metadataDb.createTagDefinition(directories, { id: 'b', name: 'B', sort_order: 'abc' });
            await metadataDb.createTagDefinition(directories, { id: 'c', name: 'C', sort_order: 1.5 });
            await metadataDb.createTagDefinition(directories, { id: 'd', name: 'D' });
            expect(orderOf('d')).toBe(4);
            expect(derived('d')?.sort_order).toBe(4);
            await metadataDb.createTagDefinition(directories, { id: 'e', name: 'E' });
            expect(orderOf('e')).toBe(5);
        });

        test('only negative orders gives 1', async () => {
            await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A', sort_order: -5 });
            await metadataDb.createTagDefinition(directories, { id: 'b', name: 'B', sort_order: -1 });
            await metadataDb.createTagDefinition(directories, { id: 'c', name: 'C' });
            expect(orderOf('c')).toBe(1);
        });

        if (ready) {
            test('is read through tags_sort_order as a covering-index search, never a scan of tags', async () => {
                await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A', sort_order: 3 });
                recording = true;
                await metadataDb.createTagDefinition(directories, { id: 'b', name: 'B' });
                recording = false;
                expect(orderOf('b')).toBe(4);
                const plans = recorded.filter(s => readsTags(s.sql)).map(planOf);
                expect(plans.some(plan => plan.includes('COVERING INDEX tags_sort_order'))).toBe(true);
                expect(plans.filter(plan => /\bSCAN tags\b/.test(plan))).toEqual([]);
            });
        }
    });

    describe('with no sort_order, before the fill', () => {
        beforeEach(async () => {
            await openStore();
            await metadataDb.fillTagNameKeysIfNeeded(directories);
        });

        test('the tag gets no order of its own, and no tags row is read to find one', async () => {
            await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A', sort_order: 3 });
            recorded = [];
            recording = true;
            expect(await metadataDb.createTagDefinition(directories, { id: 'b', name: 'B' })).toEqual({ refused: [], tag: { id: 'b', name: 'B' } });
            recording = false;
            expect(storedData('b')).toEqual({ id: 'b', name: 'B' });
            expect(derived('b')?.sort_order).toBe(null);
            expect(recorded.filter(s => /\bSELECT\b[\s\S]*\bFROM tags\b/.test(s.sql) && !/\bWHERE\b/.test(s.sql))).toEqual([]);
        });

        test('once the columns are filled, the sort-order fill numbers it after every ordered tag', async () => {
            await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A', sort_order: 3 });
            await metadataDb.createTagDefinition(directories, { id: 'b', name: 'B' });
            await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
            await metadataDb.migrateTagsJsonIfNeeded(directories);
            await metadataDb.fillTagSortOrdersIfNeeded(directories);
            expect(/** @type {any} */ (storedData('b')).sort_order).toBeGreaterThan(3);
        });
    });
});

describe('tags minted from card tags get max+1, one after another, after the fill', () => {
    const ready = true;
    /** @param {string[]} tags */
    const cardWithTags = (name, tags) => JSON.stringify({ name, spec: 'chara_card_v2', spec_version: '2.0', data: { name, tags, creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

    /** @param {string} name @returns {Record<string, unknown>[]} */
    const tagsNamed = name => withRawDb(db => [...db.prepare('SELECT data FROM tags').pluck().iterate()].map(d => JSON.parse(d)).filter(t => t.name === name));

    /** @param {string} name @returns {unknown} */
    function mintedOrder(name) {
        const found = tagsNamed(name);
        expect(found).toHaveLength(1);
        const id = /** @type {string} */ (found[0].id);
        expect(derived(id)?.sort_order).toBe(found[0].sort_order);
        return found[0].sort_order;
    }

    beforeEach(async () => {
        await openStore();
        await metadataDb.createTagDefinition(directories, { id: 'old', name: 'Old', sort_order: 4.5 });
    });

    test('seedCardTagsForSingleCharacter', async () => {
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        if (ready) await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(ready);
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardWithTags('Bob', ['Second', 'Old', 'First']));
        await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');
        expect([mintedOrder('Second'), mintedOrder('First')]).toEqual([5.5, 6.5]);
    });

    test('backfillCardTagsIfNeeded', async () => {
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        if (ready) await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardWithTags('Bob', ['Second', 'First']));
        await metadataDb.backfillCardTagsIfNeeded(directories);
        expect([mintedOrder('Second'), mintedOrder('First')]).toEqual([5.5, 6.5]);
    });

    test('a held name, once fillTagNameKeysIfNeeded resolves it', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardWithTags('Bob', ['Held']));
        expect((await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png')).heldTagNames).toEqual(['Held']);
        if (ready) {
            // The derived columns fill needs no name keys; the held name waits for them.
            await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        }
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(ready);
        expect(mintedOrder('Held')).toBe(5.5);
    });
});

test('tags minted from card tags before the fill get no order of their own', async () => {
    await openStore();
    await metadataDb.createTagDefinition(directories, { id: 'old', name: 'Old', sort_order: 4.5 });
    await metadataDb.fillTagNameKeysIfNeeded(directories);
    await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', JSON.stringify({ name: 'Bob', spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Bob', tags: ['New'], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } }));
    await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');
    const minted = withRawDb(db => [...db.prepare('SELECT data FROM tags').pluck().iterate()].map(d => JSON.parse(d)).filter(t => t.name === 'New'));
    expect(minted).toHaveLength(1);
    expect(Object.hasOwn(minted[0], 'sort_order')).toBe(false);
});

describe('editTagDefinition', () => {
    test('merges only the patch\'s fields, so a field another tab changed stays as stored', async () => {
        await openStore();
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A', color: 'red', color2: 'black' });
        // Another tab recolours.
        expect(await metadataDb.editTagDefinition(directories, 'a', { color: 'blue' })).toEqual({ refused: [] });
        // This tab only renames.
        expect(await metadataDb.editTagDefinition(directories, 'a', { name: 'Renamed', id: 'a' })).toEqual({ refused: [] });
        expect(storedData('a')).toEqual({ id: 'a', name: 'Renamed', color: 'blue', color2: 'black', sort_order: 1 });
    });

    test('a missing id is refused as missing and no row is created', async () => {
        await openStore();
        const watcher = watchWrites();
        try {
            expect(await metadataDb.editTagDefinition(directories, 'ghost', { name: 'Ghost' })).toEqual({ refused: [{ id: 'ghost', reason: 'missing' }] });
            expect(watcher.changed()).toBe(false);
        } finally {
            watcher.close();
        }
        expect(storedData('ghost')).toBeUndefined();
    });

    test('a marked id is refused as deleted with a warning, whether or not its row is still there, and no row is created', async () => {
        await openStore();
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A' });
        await metadataDb.deleteTagDefinition(directories, 'a', null);
        withRawDb(db => db.prepare('INSERT INTO tag_deletions (tag_id, merge_into) VALUES (?, NULL)').run('gone'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const watcher = watchWrites();
        try {
            expect(await metadataDb.editTagDefinition(directories, 'a', { name: 'A2' })).toEqual({ refused: [{ id: 'a', reason: 'deleted' }] });
            expect(await metadataDb.editTagDefinition(directories, 'gone', { name: 'Back' })).toEqual({ refused: [{ id: 'gone', reason: 'deleted' }] });
            expect(watcher.changed()).toBe(false);
        } finally {
            watcher.close();
        }
        expect(storedData('a')).toEqual({ id: 'a', name: 'A', sort_order: 1 });
        expect(storedData('gone')).toBeUndefined();
        const messages = warn.mock.calls.map(args => args.join(' '));
        expect(messages.some(m => m.includes('a'))).toBe(true);
        expect(messages.some(m => m.includes('gone'))).toBe(true);
    });

    test('stored data that isn\'t a JSON object is refused as unreadable and left as it is', async () => {
        await openStore();
        for (const [id, data] of [['broken', '{not json'], ['list', '[1,2]'], ['nothing', 'null'], ['text', '"x"']]) {
            withRawDb(db => db.prepare('INSERT INTO tags (id, data) VALUES (?, ?)').run(id, data));
            const watcher = watchWrites();
            try {
                expect(await metadataDb.editTagDefinition(directories, id, { name: 'N' })).toEqual({ refused: [{ id, reason: 'unreadable' }] });
                expect(watcher.changed()).toBe(false);
            } finally {
                watcher.close();
            }
            expect(withRawDb(db => db.prepare('SELECT data FROM tags WHERE id = ?').get(id))).toEqual({ data });
        }
    });

    test('an edit that changes nothing writes nothing', async () => {
        await openStore();
        await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A', color: 'red' });
        const seq = await metadataDb.getCurrentTagNameChangeSeq(directories);
        const changesSeq = await metadataDb.getTagChangesSeq(directories);
        const watcher = watchWrites();
        try {
            for (const patch of [{}, { name: 'A' }, { id: 'a', color: 'red' }]) {
                expect(await metadataDb.editTagDefinition(directories, 'a', patch)).toEqual({ refused: [] });
            }
            expect(watcher.changed()).toBe(false);
        } finally {
            watcher.close();
        }
        expect(await metadataDb.getCurrentTagNameChangeSeq(directories)).toBe(seq);
        expect(await metadataDb.getTagChangesSeq(directories)).toBe(changesSeq);
    });

    test('a name change updates name_key and is logged in tag_changes and tag_name_changes; other fields aren\'t logged in tag_name_changes', async () => {
        await openStore();
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        await metadataDb.createTagDefinition(directories, { id: 'a', name: 'A' });
        const changesSeq = await metadataDb.getTagChangesSeq(directories);
        const before = await metadataDb.getCurrentTagNameChangeSeq(directories);
        await metadataDb.editTagDefinition(directories, 'a', { name: 'Élan' });
        expect(withRawDb(db => db.prepare('SELECT name_key FROM tags WHERE id = ?').get('a'))).toEqual({ name_key: 'elan' });
        expect(await metadataDb.getTagChangesSeq(directories)).not.toBe(changesSeq);
        const page = await metadataDb.getTagNameChangesSince(directories, before, { limit: 100 });
        expect(page?.tagIds).toEqual(['a']);

        const afterRename = await metadataDb.getCurrentTagNameChangeSeq(directories);
        await metadataDb.editTagDefinition(directories, 'a', { color: 'green' });
        expect(await metadataDb.getCurrentTagNameChangeSeq(directories)).toBe(afterRename);
        expect(storedData('a')).toEqual({ id: 'a', name: 'Élan', sort_order: 1, color: 'green' });
    });
});
