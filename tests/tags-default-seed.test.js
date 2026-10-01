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

// Upstream's DEFAULT_TAGS (upstream/staging:public/scripts/tags.js), in the order upstream shows tags with no
// sort_order: alphabetical, case-insensitive (compareTagsForSort).
const SIX_IN_ORDER = ['AliChat', 'Boostyle', 'OpenAI', 'Plain Text', 'PList', 'W++'];

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    Database = (await import('better-sqlite3')).default;
});

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-default-seed-test-'));
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
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

function dbPath() {
    return path.join(directories.root, 'character-metadata.sqlite');
}

/** @param {string} key */
function metaValue(key) {
    const db = new Database(dbPath(), { readonly: true });
    try {
        return db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key);
    } finally {
        db.close();
    }
}

/** @returns {{ id: string, data: string, name_key: string, sort_order: number | null }[]} */
function tagRows() {
    const db = new Database(dbPath(), { readonly: true });
    try {
        return /** @type {any} */ (Array.from(db.prepare('SELECT id, data, name_key, sort_order FROM tags ORDER BY sort_order, rowid').iterate()));
    } finally {
        db.close();
    }
}

/** @param {string} key @param {unknown} value */
function writeKeyFile(key, value) {
    fs.mkdirSync(path.join(directories.root, 'settings'), { recursive: true });
    fs.writeFileSync(path.join(directories.root, 'settings', `${key}.json`), JSON.stringify(value, null, 4));
}

/**
 * The migration worker's two import passes, in MIGRATION_PASSES order, after the column fill that precedes them
 * there: until that fill has run, a new tag gets no sort_order of its own.
 */
async function runImportPasses() {
    await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
    await metadataDb.migrateTagsJsonIfNeeded(directories);
    await metadataDb.migrateSettingsTagsIfNeeded(directories);
}

/** @param {jest.SpiedFunction<any>[]} spies */
function logged(...spies) {
    return spies.flatMap(spy => spy.mock.calls.map(call => call.map(String).join(' '))).join('\n');
}

describe('the six default tags', () => {
    test('a new store with settings that have no tags key gets the six, max+1 upward alphabetically, once', async () => {
        writeKeyFile('power_user', { theme: 'x' });

        await metadataDb.ensureSchemaMigrated(directories);
        expect(metaValue('tags_seed_pending')).toBeTruthy();

        await runImportPasses();

        const rows = tagRows();
        expect(rows.map(row => JSON.parse(row.data).name)).toEqual(SIX_IN_ORDER);
        expect(rows.map(row => row.sort_order)).toEqual([1, 2, 3, 4, 5, 6]);
        for (const row of rows) {
            const data = JSON.parse(row.data);
            expect(Object.keys(data).sort()).toEqual(['create_date', 'id', 'name', 'sort_order']);
            expect(data.id).toBe(row.id);
            expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            expect(typeof data.create_date).toBe('number');
            expect(row.name_key).toBe(data.name.toLowerCase());
            expect(row.sort_order).toBe(data.sort_order);
        }
        expect(metaValue('tags_seed_pending')).toBeUndefined();

        // Decided once: a later run, even with the pass restarted, never seeds again.
        await metadataDb.restartSettingsTagsImport(directories);
        await runImportPasses();
        expect(tagRows()).toHaveLength(6);
    });

    test('a new store with no settings at all gets the six', async () => {
        await runImportPasses();
        expect(tagRows().map(row => JSON.parse(row.data).name)).toEqual(SIX_IN_ORDER);
    });

    test('a new store whose legacy settings.json has a tags key gets none of the six', async () => {
        fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ tags: [{ id: 'mine', name: 'Mine' }] }));

        await runImportPasses();

        expect(tagRows().map(row => row.id)).toEqual(['mine']);
        expect(metaValue('tags_seed_pending')).toBeUndefined();
    });

    test('a new store with settings/tags.json gets none of the six, even an empty list', async () => {
        writeKeyFile('tags', []);

        await runImportPasses();

        expect(tagRows()).toEqual([]);
        expect(metaValue('tags_seed_pending')).toBeUndefined();
    });

    test('a new store with a tags.json gets none of the six', async () => {
        fs.writeFileSync(path.join(directories.root, 'tags.json'), JSON.stringify({ tags: [{ id: 'old', name: 'Old' }], tag_map: {} }));

        await metadataDb.ensureSchemaMigrated(directories);
        await metadataDb.migrateTagsJsonIfNeeded(directories);
        expect(metaValue('tags_seed_pending')).toBeUndefined();
        await metadataDb.migrateSettingsTagsIfNeeded(directories);

        expect(tagRows().map(row => row.id)).toEqual(['old']);
    });

    test('a new store with an unreadable settings file gets none of the six, names the file, and never seeds later', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const legacyPath = path.join(directories.root, 'settings.json');
        fs.writeFileSync(legacyPath, '{ not json');

        await runImportPasses();

        expect(tagRows()).toEqual([]);
        expect(metaValue('tags_seed_pending')).toBeUndefined();
        expect(logged(warn, error)).toMatch(new RegExp(`default tags[^\\n]*${legacyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

        // The file becomes readable with no tags key on a later boot: still no seed.
        fs.writeFileSync(legacyPath, JSON.stringify({ power_user: {} }));
        await runImportPasses();
        expect(tagRows()).toEqual([]);
    });

    test('an existing store gets none of the six', async () => {
        // The database file is already there when the store opens it.
        new Database(dbPath()).close();

        await metadataDb.ensureSchemaMigrated(directories);
        expect(metaValue('tags_seed_pending')).toBeUndefined();
        await runImportPasses();

        expect(tagRows()).toEqual([]);
    });
});
