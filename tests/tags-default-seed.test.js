import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('./tag-store-reads.js').storedTagDefinitions} */
let storedTagDefinitions;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

// Upstream's DEFAULT_TAGS (upstream/staging:public/scripts/tags.js), in the order upstream shows tags with no
// sort_order: alphabetical, case-insensitive (compareTagsForSort).
const SIX_IN_ORDER = ['AliChat', 'Boostyle', 'OpenAI', 'Plain Text', 'PList', 'W++'];

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    fixture = await import('./converted-user.fixture.js');
    ({ storedTagDefinitions } = await import('./tag-store-reads.js'));
});

beforeEach(async () => {
    user = await fixture.emptyUser('st-tags-default-seed-test-');
    directories = user.directories;
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(async () => {
    jest.restoreAllMocks();
    await user.close();
});

/** @param {string} key */
async function metaValue(key) {
    return (await user.store.lib.store.meta([key]))[0] ?? undefined;
}

/** @returns {Promise<{ id: string, data: any, sort_order: number | null }[]>} */
async function tagRows() {
    return (await storedTagDefinitions(user.store.lib)).map(tag => ({ id: tag.id, data: tag, sort_order: tag.sort_order ?? null }));
}

/** @param {string} key @param {unknown} value */
function writeKeyFile(key, value) {
    fs.mkdirSync(path.join(directories.root, 'settings'), { recursive: true });
    fs.writeFileSync(path.join(directories.root, 'settings', `${key}.json`), JSON.stringify(value, null, 4));
}

/** The settings tags import, which decides the default tags of a new store. */
async function runImportPasses() {
    await user.store.lib.tags.importSettingsTags(directories);
}

/** @param {jest.SpiedFunction<any>[]} spies */
function logged(...spies) {
    return spies.flatMap(spy => spy.mock.calls.map(call => call.map(String).join(' '))).join('\n');
}

describe('the six default tags', () => {
    test('a new store with settings that have no tags key gets the six, max+1 upward alphabetically, once', async () => {
        writeKeyFile('power_user', { theme: 'x' });

        expect(await metaValue('tags_seed_pending')).toBeTruthy();

        await runImportPasses();

        const rows = await tagRows();
        expect(rows.map(row => row.data.name)).toEqual(SIX_IN_ORDER);
        expect(rows.map(row => row.sort_order)).toEqual([1, 2, 3, 4, 5, 6]);
        for (const row of rows) {
            expect(Object.keys(row.data).sort()).toEqual(['create_date', 'id', 'name', 'sort_order']);
            expect(row.data.id).toBe(row.id);
            expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            expect(typeof row.data.create_date).toBe('number');
        }
        expect(await metaValue('tags_seed_pending')).toBeUndefined();

        // Decided once: a later run, even with the pass restarted, never seeds again.
        await user.store.lib.tags.restartSettingsImport();
        await runImportPasses();
        expect(await tagRows()).toHaveLength(6);
    });

    test('a new store with no settings at all gets the six', async () => {
        await runImportPasses();
        expect((await tagRows()).map(row => row.data.name)).toEqual(SIX_IN_ORDER);
    });

    test('a new store whose legacy settings.json has a tags key gets none of the six', async () => {
        fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ tags: [{ id: 'mine', name: 'Mine' }] }));

        await runImportPasses();

        expect((await tagRows()).map(row => row.id)).toEqual(['mine']);
        expect(await metaValue('tags_seed_pending')).toBeUndefined();
    });

    test('a new store with settings/tags.json gets none of the six, even an empty list', async () => {
        writeKeyFile('tags', []);

        await runImportPasses();

        expect(await tagRows()).toEqual([]);
        expect(await metaValue('tags_seed_pending')).toBeUndefined();
    });

    test('a new store with an unreadable settings file gets none of the six, names the file, and never seeds later', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const legacyPath = path.join(directories.root, 'settings.json');
        fs.writeFileSync(legacyPath, '{ not json');

        await runImportPasses();

        expect(await tagRows()).toEqual([]);
        expect(await metaValue('tags_seed_pending')).toBeUndefined();
        expect(logged(warn, error)).toMatch(new RegExp(`default tags[^\\n]*${legacyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

        // The file becomes readable with no tags key on a later boot: still no seed.
        fs.writeFileSync(legacyPath, JSON.stringify({ power_user: {} }));
        await runImportPasses();
        expect(await tagRows()).toEqual([]);
    });

    test('an existing store gets none of the six', async () => {
        // A store that was there before: it is not marked new.
        await user.store.lib.store.commit([{ kind: 'metaValue', key: 'tags_seed_pending' }]);
        await runImportPasses();

        expect(await tagRows()).toEqual([]);
    });
});
