import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('better-sqlite3')} */
let Database;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
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

    test('upsertTagDefinition, on insert and on update', async () => {
        await openStore();
        await metadataDb.upsertTagDefinition(directories, { id: 'a', name: 'A', sort_order: null, folder_type: null });
        expect(derived('a')).toEqual({ sort_order: 0, folder_type: 'null', is_folder: 1, usage_count: 0 });
        await metadataDb.upsertTagDefinition(directories, { id: 'a', name: 'A', sort_order: 2.5, folder_type: 'NONE' });
        expect(derived('a')).toEqual({ sort_order: 2.5, folder_type: 'NONE', is_folder: 0, usage_count: 0 });
        await metadataDb.upsertTagDefinition(directories, { id: 'a', name: 'A' });
        expect(derived('a')).toEqual({ sort_order: null, folder_type: 'NONE', is_folder: 0, usage_count: 0 });
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
        const name = 'Brand New';
        const json = JSON.stringify({ name: 'Bob', spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Bob', tags: [name], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', json);
        const { tagIds } = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');
        expect(tagIds).toHaveLength(1);
        expect(usageCount(tagIds[0])).toBe(1);
        expect(derived(tagIds[0])).toEqual({ sort_order: null, folder_type: 'NONE', is_folder: 0, usage_count: 1 });
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

        await metadataDb.upsertTagDefinition(directories, { id: 'early', name: 'Early' });
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
