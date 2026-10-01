import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../public/scripts/hash-utils.js').tagNameKey} */
let tagNameKey;
/** @type {typeof import('better-sqlite3')} */
let Database;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    ({ tagNameKey } = await import('../public/scripts/hash-utils.js'));
    Database = (await import('better-sqlite3')).default;
});

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tag-name-keys-test-'));
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
 * @param {string} avatar
 * @param {string[]} tags
 * @param {{ fromImport?: boolean }} [options] As for upsertCharacterFromWrite().
 */
async function writeCharacter(avatar, tags, options = {}) {
    const name = path.parse(avatar).name;
    const card = { name, spec: 'chara_card_v2', spec_version: '2.0', data: { name, tags, creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } };
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify(card), null, null, options);
}

/**
 * Runs fn against a second connection to the store, as another thread's writes would arrive.
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

/** @returns {{ id: string, name: string, name_key: string | null }[]} */
function tagRows() {
    return withRawDb(db => Array.from(db.prepare('SELECT id, json_extract(data, \'$.name\') AS name, name_key FROM tags ORDER BY rowid').iterate()));
}

/** @param {string} avatar */
function assignedTagIds(avatar) {
    return withRawDb(db => Array.from(db.prepare('SELECT tag_id FROM character_tags WHERE character_id = ? ORDER BY tag_id').iterate(avatar), r => r.tag_id));
}

/** @param {string} [avatar] */
function heldNames(avatar) {
    return withRawDb(db => (avatar === undefined
        ? Array.from(db.prepare('SELECT character_id, name FROM tag_names_held ORDER BY character_id, name').iterate())
        : Array.from(db.prepare('SELECT name FROM tag_names_held WHERE character_id = ? ORDER BY name').iterate(avatar), r => r.name)));
}

/** A store whose tags rows predate name_key: every key NULL and no index. */
async function makeTagsLegacy() {
    await metadataDb.ensureSchemaMigrated(directories);
    withRawDb((db) => {
        db.exec('DROP INDEX IF EXISTS tags_name_key');
        db.exec('UPDATE tags SET name_key = NULL');
    });
}

describe('tagNameKey()', () => {
    test('matches names the way upstream\'s getTag() does: ignoring case and accents', () => {
        expect(tagNameKey('Élan')).toBe(tagNameKey('elan'));
        expect(tagNameKey('ÉLAN')).toBe(tagNameKey('élan'));
        expect(tagNameKey('Fantasy')).toBe(tagNameKey('fantasy'));
        expect(tagNameKey('Straße')).not.toBe(tagNameKey('strasse'));
        expect(tagNameKey('Elan')).not.toBe(tagNameKey('Elan '));
    });
});

describe('name_key on every tags write', () => {
    test('saveTagDefinitions, createTagDefinition, editTagDefinition (a rename) and card tag creation set it', async () => {
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        await metadataDb.saveTagDefinitions(directories, [{ id: 'a', name: 'Élan' }, { id: 'b' }]);
        await metadataDb.createTagDefinition(directories, { id: 'c', name: 'Noir' });
        await metadataDb.editTagDefinition(directories, 'a', { name: 'Renamed' });
        await writeCharacter('Bob.png', ['Brand New']);
        await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');

        const keys = Object.fromEntries(tagRows().map(r => [r.name ?? r.id, r.name_key]));
        expect(keys).toEqual({ Renamed: 'renamed', b: '', Noir: 'noir', 'Brand New': 'brand new' });
    });

    test('migrateTagsJsonIfNeeded sets it', async () => {
        fs.writeFileSync(path.join(directories.root, 'tags.json'), JSON.stringify({ tags: [{ id: 't1', name: 'Café' }], tag_map: {} }));
        await metadataDb.migrateTagsJsonIfNeeded(directories);
        expect(tagRows()).toEqual([{ id: 't1', name: 'Café', name_key: 'cafe' }]);
    });
});

describe('resolving card tag names once name keys are filled', () => {
    beforeEach(async () => {
        await metadataDb.fillTagNameKeysIfNeeded(directories);
    });

    test('a name matches an existing tag ignoring case and accents', async () => {
        await metadataDb.saveTagDefinitions(directories, [{ id: 'elan', name: 'Élan' }]);
        await writeCharacter('Bob.png', ['elan']);

        const { tagIds, heldTagNames } = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');

        expect(tagIds).toEqual(['elan']);
        expect(heldTagNames).toEqual([]);
        expect(tagRows()).toHaveLength(1);
    });

    test('where names already collide, the first tag by rowid wins', async () => {
        await metadataDb.saveTagDefinitions(directories, [{ id: 'z-first', name: 'Dup' }, { id: 'a-second', name: 'dup' }]);
        await writeCharacter('Bob.png', ['DUP']);

        expect((await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png')).tagIds).toEqual(['z-first']);
    });

    test('a tag another connection created is found, not created again', async () => {
        await writeCharacter('Alice.png', ['Other']);
        await metadataDb.seedCardTagsForSingleCharacter(directories, 'Alice.png');
        withRawDb(db => db.prepare('INSERT INTO tags (id, data, name_key) VALUES (?, ?, ?)').run('worker-made', JSON.stringify({ id: 'worker-made', name: 'Beta' }), 'beta'));
        await writeCharacter('Bob.png', ['beta']);

        const { tagIds, tagDefinitions } = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');

        expect(tagIds).toEqual(['worker-made']);
        expect(tagDefinitions).toEqual([{ id: 'worker-made', name: 'Beta' }]);
        expect(tagRows().filter(r => r.name_key === 'beta')).toHaveLength(1);
    });

    test('the worker\'s card tags backfill finds a tag this process created, and creates none again', async () => {
        await writeCharacter('Alice.png', ['Gamma']);
        const { tagIds: [gammaId] } = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Alice.png');
        await writeCharacter('Bob.png', ['GAMMA', 'Fresh']);

        await metadataDb.backfillCardTagsIfNeeded(directories);

        expect(tagRows().filter(r => r.name_key === 'gamma')).toHaveLength(1);
        expect(assignedTagIds('Bob.png')).toContain(gammaId);
        expect(tagRows().filter(r => r.name_key === 'fresh')).toHaveLength(1);
    });

    test('only-existing mode never creates a tag', async () => {
        await writeCharacter('Bob.png', ['Nowhere']);
        const { tagIds, heldTagNames } = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png', { onlyExisting: true });
        expect(tagIds).toEqual([]);
        expect(heldTagNames).toEqual([]);
        expect(tagRows()).toEqual([]);
    });
});

describe('while name keys are unfilled', () => {
    test('a name an existing tag has is held, and the fill pass assigns that tag', async () => {
        await metadataDb.saveTagDefinitions(directories, [{ id: 'known', name: 'Known' }]);
        await makeTagsLegacy();
        await writeCharacter('Bob.png', ['known']);

        const { tagIds, heldTagNames } = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');

        expect(tagIds).toEqual([]);
        expect(heldTagNames).toEqual(['known']);
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        expect(assignedTagIds('Bob.png')).toEqual(['known']);
        expect(tagRows().filter(r => r.name_key === 'known')).toHaveLength(1);
    });

    test('a name is held, not created, and the fill pass assigns the tag another connection made', async () => {
        await metadataDb.saveTagDefinitions(directories, [{ id: 'other', name: 'Other' }]);
        await makeTagsLegacy();
        withRawDb(db => db.prepare('INSERT INTO tags (id, data) VALUES (?, ?)').run('elsewhere', JSON.stringify({ id: 'elsewhere', name: 'Beta' })));
        await writeCharacter('Bob.png', ['Béta', 'Brand New']);

        const { tagIds, heldTagNames } = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');

        expect(tagIds).toEqual([]);
        expect(heldTagNames).toEqual(['Béta', 'Brand New']);
        expect(heldNames('Bob.png')).toEqual(['Brand New', 'Béta']);
        expect(tagRows().map(r => r.name).sort()).toEqual(['Beta', 'Other']);

        await metadataDb.fillTagNameKeysIfNeeded(directories);

        expect(heldNames()).toEqual([]);
        const brandNew = tagRows().find(r => r.name === 'Brand New');
        expect(brandNew).toBeDefined();
        expect(tagRows().filter(r => r.name_key === 'beta')).toHaveLength(1);
        expect(assignedTagIds('Bob.png')).toEqual(['elsewhere', /** @type {any} */ (brandNew).id].sort());
        expect(/** @type {any} */ (await metadataDb.getShallowByIds(directories, ['Bob.png']))['Bob.png'].tag_ids).toEqual(['elsewhere', /** @type {any} */ (brandNew).id].sort());
    });

    test('a name held in only-existing mode is assigned if the tag exists, and never created', async () => {
        await metadataDb.saveTagDefinitions(directories, [{ id: 'other', name: 'Other' }]);
        await makeTagsLegacy();
        withRawDb(db => db.prepare('INSERT INTO tags (id, data) VALUES (?, ?)').run('exists', JSON.stringify({ id: 'exists', name: 'Exists' })));
        await writeCharacter('Bob.png', ['Exists', 'Missing']);

        expect((await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png', { onlyExisting: true })).heldTagNames).toEqual(['Exists', 'Missing']);
        await metadataDb.fillTagNameKeysIfNeeded(directories);

        expect(assignedTagIds('Bob.png')).toEqual(['exists']);
        expect(tagRows().some(r => r.name === 'Missing')).toBe(false);
    });

    test('a card still in the batch-import buffer is written to the table with its held names', async () => {
        await makeTagsLegacy();
        await metadataDb.beginBatchImport(directories);
        await writeCharacter('Bob.png', ['Pending'], { fromImport: true });
        expect(withRawDb(db => db.prepare('SELECT 1 FROM characters WHERE id = ?').get('Bob.png'))).toBeUndefined();

        const { heldTagNames } = await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');

        expect(heldTagNames).toEqual(['Pending']);
        expect(withRawDb(db => db.prepare('SELECT 1 AS found FROM characters WHERE id = ?').get('Bob.png'))).toEqual({ found: 1 });
        await metadataDb.endBatchImport(directories);
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        expect(assignedTagIds('Bob.png')).toHaveLength(1);
    });

    test('a rename moves the held names to the new avatar; a delete drops them', async () => {
        await makeTagsLegacy();
        await writeCharacter('Old.png', ['Moved']);
        await writeCharacter('Gone.png', ['Dropped']);
        await metadataDb.seedCardTagsForSingleCharacter(directories, 'Old.png');
        await metadataDb.seedCardTagsForSingleCharacter(directories, 'Gone.png');

        await writeCharacter('New.png', []);
        await metadataDb.renameCharacterRow(directories, 'Old.png', 'New.png');
        await metadataDb.deleteCharacterRow(directories, 'Gone.png');

        expect(heldNames()).toEqual([{ character_id: 'New.png', name: 'Moved' }]);
    });

    test('a held name whose character is gone is dropped with a warning naming it', async () => {
        await makeTagsLegacy();
        await writeCharacter('Bob.png', ['Orphan']);
        await metadataDb.seedCardTagsForSingleCharacter(directories, 'Bob.png');
        withRawDb(db => db.prepare('DELETE FROM characters WHERE id = ?').run('Bob.png'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await metadataDb.fillTagNameKeysIfNeeded(directories);

        expect(heldNames()).toEqual([]);
        expect(warn.mock.calls.flat().join('\n')).toContain('Bob.png: Orphan');
        warn.mockRestore();
    });
});

describe('fillTagNameKeysIfNeeded()', () => {
    test('fills every row in bounded batches and builds the index', async () => {
        await metadataDb.saveTagDefinitions(directories, Array.from({ length: 1001 }, (_, i) => ({ id: `t${i}`, name: `Tag ${i}` })));
        await makeTagsLegacy();

        const result = await metadataDb.fillTagNameKeysIfNeeded(directories);

        expect(result).toEqual({ batches: 2, rowsChanged: 1001 });
        expect(tagRows().every(r => r.name_key === tagNameKey(r.name))).toBe(true);
        expect(withRawDb(db => db.prepare('SELECT 1 AS found FROM sqlite_master WHERE type = \'index\' AND name = \'tags_name_key\'').get())).toEqual({ found: 1 });
        expect(await metadataDb.fillTagNameKeysIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });
    });
});
