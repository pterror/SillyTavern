import { describe, test, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The real coordinator's pass waits for a boot chain these tests never run.
const requestMetadataMigrationPass = jest.fn(() => Promise.resolve());
jest.unstable_mockModule('../src/metadata-migration-coordinator.js', () => ({
    requestMetadataMigrationPass,
    startMetadataMigrations: () => Promise.resolve(),
    whenMetadataMigrationsIdle: () => Promise.resolve(),
    disposeMetadataMigrationWorkers: () => Promise.resolve(),
    MIGRATION_PASSES: [],
}));

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;
let directories;

beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-settings-restore-tags-test-'));
    directories = {
        root: tempDir,
        backups: path.join(tempDir, 'backups'),
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    for (const dir of [directories.backups, directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    Database = (await import('better-sqlite3')).default;
    // An existing store, which never gets the default tags (tags-default-seed.test.js).
    new Database(path.join(tempDir, 'character-metadata.sqlite')).close();

    const { router } = await import('../src/endpoints/settings.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: 'test-user' } };
        next();
    });
    app.use('/api/settings', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    metadataDb.disposeMetadataStores();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
    requestMetadataMigrationPass.mockClear();
});

function flag() {
    const db = new Database(path.join(tempDir, 'character-metadata.sqlite'), { readonly: true });
    try {
        return db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get('settings_tags_migrated');
    } finally {
        db.close();
    }
}

/** @param {string} name @param {object} snapshot */
function restore(name, snapshot) {
    const fileName = `settings_test-user_${name}.json`;
    fs.writeFileSync(path.join(directories.backups, fileName), JSON.stringify(snapshot));
    return fetch(`${baseUrl}/api/settings/restore-snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fileName }),
    });
}

describe('POST /api/settings/restore-snapshot and the settings tags import', () => {
    test('a snapshot with tags clears the done flag and asks for the pass, which then imports them', async () => {
        await metadataDb.migrateSettingsTagsIfNeeded(directories);
        expect(flag()).toBeTruthy();

        const response = await restore('with-tags', { power_user: {}, tags: [{ id: 'r1', name: 'Restored' }], tag_map: {} });

        expect(response.status).toBe(204);
        expect(flag()).toBeUndefined();
        expect(requestMetadataMigrationPass).toHaveBeenCalledWith(directories, 'migrateSettingsTagsIfNeeded');

        await metadataDb.migrateSettingsTagsIfNeeded(directories);
        expect((await metadataDb.getTagDefinitions(directories)).map(t => t.id)).toEqual(['r1']);
        expect(flag()).toBeTruthy();
    });

    test('a snapshot with neither tags nor tag_map leaves the flag and asks for nothing', async () => {
        await metadataDb.migrateSettingsTagsIfNeeded(directories);
        const before = flag();
        expect(before).toBeTruthy();

        const response = await restore('without-tags', { power_user: {} });

        expect(response.status).toBe(204);
        expect(flag()).toBe(before);
        expect(requestMetadataMigrationPass).not.toHaveBeenCalled();
    });
});
