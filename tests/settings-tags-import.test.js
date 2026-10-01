import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storedTagDefinitions } from './tag-store-reads.js';

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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-settings-tags-import-test-'));
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
    // An existing store, which never gets the default tags (tags-default-seed.test.js).
    new Database(path.join(root, 'character-metadata.sqlite')).close();
});

afterEach(() => {
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

function cardJson() {
    return JSON.stringify({
        name: 'Bob',
        fav: false,
        create_date: '2024-01-01T00:00:00.000Z',
        data: { name: 'Bob', tags: [], creator: 'tester', character_version: '1.0', creator_notes: '', extensions: { fav: false, world: '' } },
    });
}

/** Bob.png and group1, as the boot chain would have them before the pass runs. */
async function seedEntities() {
    await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson());
    fs.writeFileSync(path.join(directories.groups, 'group1.json'), JSON.stringify({ id: 'group1', name: 'G', members: [] }));
    await metadataDb.bootstrapGroupsIfNeeded(directories);
}

/** @param {string} name */
function keyFilePath(name) {
    return path.join(directories.root, 'settings', name);
}

/** @param {string} key @param {unknown} value @returns {string} The text written. */
function writeKeyFile(key, value) {
    fs.mkdirSync(path.join(directories.root, 'settings'), { recursive: true });
    const text = JSON.stringify(value, null, 4);
    fs.writeFileSync(keyFilePath(`${key}.json`), text);
    return text;
}

/** @param {string} key */
function metaValue(key) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'), { readonly: true });
    try {
        return db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key);
    } finally {
        db.close();
    }
}

/** @returns {Promise<Record<string, any>>} Stored definitions by id. */
async function definitionsById() {
    return Object.fromEntries((await storedTagDefinitions(metadataDb, directories)).map(t => [t.id, t]));
}

/** @param {jest.SpiedFunction<any>[]} spies */
function logged(...spies) {
    return spies.flatMap(spy => spy.mock.calls.map(call => call.map(String).join(' '))).join('\n');
}

describe('migrateSettingsTagsIfNeeded', () => {
    test('imports settings/tags.json and settings/tag_map.json, renames them to .migrated and marks the pass done', async () => {
        await seedEntities();
        const tags = [
            { id: 't1', name: 'Zeta' },
            { id: 't2', name: 'alpha' },
            { id: 't3', name: 'Mid', sort_order: 5 },
        ];
        const tagMap = { 'Bob.png': ['t1', 't2'], group1: ['t3'] };
        const tagsText = writeKeyFile('tags', tags);
        const tagMapText = writeKeyFile('tag_map', tagMap);

        // As in MIGRATION_PASSES: until the column fill has run, a new tag gets no sort_order of its own.
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        await metadataDb.migrateSettingsTagsIfNeeded(directories);

        const defs = await definitionsById();
        expect(defs.t3).toEqual({ id: 't3', name: 'Mid', sort_order: 5 });
        // No sort_order of their own: max+1 upward, alphabetically, after the ordered ones.
        expect(defs.t2).toEqual({ id: 't2', name: 'alpha', sort_order: 6 });
        expect(defs.t1).toEqual({ id: 't1', name: 'Zeta', sort_order: 7 });
        expect([...await metadataDb.getCharacterTagIds(directories, 'Bob.png')].sort()).toEqual(['t1', 't2']);
        expect(await metadataDb.getGroupTagIds(directories, 'group1')).toEqual(['t3']);

        expect(fs.existsSync(keyFilePath('tags.json'))).toBe(false);
        expect(fs.existsSync(keyFilePath('tag_map.json'))).toBe(false);
        expect(fs.readFileSync(keyFilePath('tags.json.migrated'), 'utf8')).toBe(tagsText);
        expect(fs.readFileSync(keyFilePath('tag_map.json.migrated'), 'utf8')).toBe(tagMapText);
        expect(metaValue('settings_tags_migrated')).toBeTruthy();
    });

    test('imports a legacy settings.json not yet split, never touches it, and stays not done while it exists', async () => {
        await seedEntities();
        const legacyPath = path.join(directories.root, 'settings.json');
        const legacyText = JSON.stringify({
            power_user: { theme: 'dark' },
            tags: [{ id: '1345561466591', name: 'ST Default' }],
            tag_map: { 'Bob.png': ['1345561466591'] },
        }, null, 4);
        fs.writeFileSync(legacyPath, legacyText);

        await metadataDb.migrateSettingsTagsIfNeeded(directories);

        expect((await definitionsById())['1345561466591']).toMatchObject({ name: 'ST Default' });
        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual(['1345561466591']);
        expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyText);
        expect(fs.existsSync(path.join(directories.root, 'settings'))).toBe(false);
        expect(metaValue('settings_tags_migrated')).toBeUndefined();
    });

    test('skips what already exists and lists every skipped tag, key and tag id', async () => {
        await seedEntities();
        await metadataDb.createTagDefinition(directories, { id: 'x1', name: 'Kept', sort_order: 1 });
        writeKeyFile('tags', [
            { id: 'x1', name: 'From settings' },
            { name: 'No id' },
            'not a tag',
            { id: 'n1', name: 'New' },
        ]);
        writeKeyFile('tag_map', { 'Bob.png': ['n1', 'ghost-tag'], 'Ghost.png': ['n1'] });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await metadataDb.migrateSettingsTagsIfNeeded(directories);

        const defs = await definitionsById();
        expect(defs.x1).toEqual({ id: 'x1', name: 'Kept', sort_order: 1 });
        expect(defs.n1).toMatchObject({ name: 'New' });
        expect(Object.keys(defs).sort()).toEqual(['n1', 'x1']);
        // An assignment to a tag with no definition isn't made.
        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual(['n1']);

        const text = logged(warn, log, error);
        expect(text).toContain('x1');
        expect(text).toContain('No id');
        expect(text).toContain('not a tag');
        expect(text).toContain('ghost-tag');
        expect(text).toContain('Ghost.png');
        expect(fs.existsSync(keyFilePath('tags.json.migrated'))).toBe(true);
        expect(metaValue('settings_tags_migrated')).toBeTruthy();
    });

    test('an unreadable tags.json imports nothing from its source, leaves both files and names the file', async () => {
        await seedEntities();
        fs.mkdirSync(path.join(directories.root, 'settings'), { recursive: true });
        fs.writeFileSync(keyFilePath('tags.json'), '{ not json');
        const tagMapText = writeKeyFile('tag_map', { 'Bob.png': ['t1'] });
        await metadataDb.createTagDefinition(directories, { id: 't1', name: 'Exists' });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await metadataDb.migrateSettingsTagsIfNeeded(directories);

        expect(await metadataDb.getCharacterTagIds(directories, 'Bob.png')).toEqual([]);
        expect(fs.readFileSync(keyFilePath('tags.json'), 'utf8')).toBe('{ not json');
        expect(fs.readFileSync(keyFilePath('tag_map.json'), 'utf8')).toBe(tagMapText);
        expect(logged(warn, error)).toContain(keyFilePath('tags.json'));
        expect(metaValue('settings_tags_migrated')).toBeUndefined();
    });

    test('never overwrites an older .migrated file', async () => {
        await seedEntities();
        fs.mkdirSync(path.join(directories.root, 'settings'), { recursive: true });
        fs.writeFileSync(keyFilePath('tags.json.migrated'), 'older');
        const tagsText = writeKeyFile('tags', [{ id: 't1', name: 'One' }]);

        await metadataDb.migrateSettingsTagsIfNeeded(directories);

        expect(fs.readFileSync(keyFilePath('tags.json.migrated'), 'utf8')).toBe('older');
        const renamed = fs.readdirSync(path.join(directories.root, 'settings')).filter(f => f.startsWith('tags.json.migrated-'));
        expect(renamed).toHaveLength(1);
        expect(fs.readFileSync(keyFilePath(renamed[0]), 'utf8')).toBe(tagsText);
        expect(fs.existsSync(keyFilePath('tags.json'))).toBe(false);
    });

    test('runs right after migrateTagsJsonIfNeeded in MIGRATION_PASSES', async () => {
        const { MIGRATION_PASSES } = await import('../src/metadata-migration-coordinator.js');
        expect(MIGRATION_PASSES[MIGRATION_PASSES.indexOf(/** @type {any} */ ('migrateSettingsTagsIfNeeded')) - 1]).toBe('migrateTagsJsonIfNeeded');
    });

    test('with no source it marks the pass done, and a done pass reads nothing', async () => {
        await seedEntities();

        await metadataDb.migrateSettingsTagsIfNeeded(directories);
        expect(metaValue('settings_tags_migrated')).toBeTruthy();

        writeKeyFile('tags', [{ id: 't1', name: 'Later' }]);
        await metadataDb.migrateSettingsTagsIfNeeded(directories);
        expect(await definitionsById()).toEqual({});
        expect(fs.existsSync(keyFilePath('tags.json'))).toBe(true);
    });
});
