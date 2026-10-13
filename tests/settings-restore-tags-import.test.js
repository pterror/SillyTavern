import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { storedTagDefinitions } from './tag-store-reads.js';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    fixture = await import('./converted-user.fixture.js');

    const { router } = await import('../src/endpoints/settings.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/settings', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-settings-restore-tags-test-');
    directories = user.directories;
    globalThis.DATA_ROOT = user.dataRoot;
    fs.mkdirSync(directories.backups, { recursive: true });
    // An existing store, which never gets the default tags (tags-default-seed.test.js).
    await user.store.lib.store.commit([{ kind: 'metaValue', key: 'tags_seed_pending' }]);
});

afterEach(() => user.close());

async function flag() {
    return (await user.store.lib.store.meta(['settings_tags_migrated']))[0] ?? undefined;
}

/** Waits for what `ready()` reads to be true: the import after a restore runs on its own. @param {() => Promise<boolean>} ready */
async function until(ready) {
    for (let i = 0; i < 100 && !await ready(); i++) await new Promise(resolve => setTimeout(resolve, 50));
}

/** @param {string} name @param {object} snapshot */
function restore(name, snapshot) {
    const fileName = `settings_u_${name}.json`;
    fs.writeFileSync(path.join(directories.backups, fileName), JSON.stringify(snapshot));
    return fetch(`${baseUrl}/api/settings/restore-snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fileName }),
    });
}

describe('POST /api/settings/restore-snapshot and the settings tags import', () => {
    test('a snapshot with tags clears the done flag and runs the import, which then imports them', async () => {
        await user.store.lib.tags.importSettingsTags(directories);
        expect(await flag()).toBeTruthy();

        const response = await restore('with-tags', { power_user: {}, tags: [{ id: 'r1', name: 'Restored' }], tag_map: {} });

        expect(response.status).toBe(204);
        await until(async () => (await storedTagDefinitions(user.store.lib)).length > 0 && await flag() !== undefined);
        expect((await storedTagDefinitions(user.store.lib)).map(t => t.id)).toEqual(['r1']);
        expect(await flag()).toBeTruthy();
    });

    test('a snapshot with neither tags nor tag_map leaves the flag and imports nothing', async () => {
        await user.store.lib.tags.importSettingsTags(directories);
        const before = await flag();
        expect(before).toBeTruthy();

        const response = await restore('without-tags', { power_user: {} });

        expect(response.status).toBe(204);
        expect(await flag()).toBe(before);
        expect(await storedTagDefinitions(user.store.lib)).toEqual([]);
    });
});
