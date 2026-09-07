import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {import('express').Router} */
let router;
/** @type {(str: string, seed?: number) => number} */
let getStringHash;
/** @type {typeof import('../src/settings-store.js')} */
let settingsStore;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;
let directories;

/**
 * Mounts the real settings.js router behind a fake auth middleware, same shape as avatars-get.test.js /
 * tags-endpoints.test.js. Covers /api/settings/save's optimistic-concurrency check (X-Settings-Hash) added to
 * close the silent-clobber gap where two tabs/devices saving around the same time would have the later POST
 * blindly overwrite the earlier one's change - see checkSettingsConflict() in src/endpoints/settings.js.
 */
beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-settings-save-test-'));
    fs.mkdirSync(path.join(tempDir, 'backups'), { recursive: true });
    directories = { root: tempDir, backups: path.join(tempDir, 'backups') };

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ getStringHash } = await import('../public/scripts/hash-utils.js'));
    settingsStore = await import('../src/settings-store.js');
    ({ router } = await import('../src/endpoints/settings.js'));
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = {
            directories,
            profile: { handle: 'test-user' },
        };
        next();
    });
    app.use('/api/settings', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

/**
 * @param {object} body
 * @param {string} [expectedHash]
 */
async function postSave(body, expectedHash) {
    const headers = { 'Content-Type': 'application/json' };
    if (expectedHash !== undefined) {
        headers['X-Settings-Hash'] = expectedHash;
    }
    return fetch(`${baseUrl}/api/settings/save`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

/** Full replace via the sharded store, deleting stray per-key files from a previous test. */
function writeSettingsFile(obj) {
    settingsStore.writeAllSettings(directories, obj);
    return JSON.stringify(obj, null, 4);
}

function readSettingsFile() {
    return settingsStore.readAllSettings(directories);
}

function eraseSettings() {
    settingsStore.deleteAllSettings(directories);
}

describe('POST /api/settings/save conflict detection', () => {
    test('writes unconditionally when no X-Settings-Hash header is sent (backward compatible)', async () => {
        const response = await postSave({ a: 1 });
        expect(response.status).toBe(200);
        expect(readSettingsFile()).toEqual({ a: 1 });
    });

    test('proceeds when the sent hash matches the current on-disk content', async () => {
        writeSettingsFile({ a: 1 });
        const currentHash = String(getStringHash(settingsStore.readAllSettingsAsJson(directories)));

        const response = await postSave({ a: 2 }, currentHash);

        expect(response.status).toBe(200);
        expect(readSettingsFile()).toEqual({ a: 2 });
    });

    test('rejects with 409 and leaves the file untouched when the sent hash is stale', async () => {
        // Simulates: this client last saw {a: 1} (from an earlier /get or /save), but some other tab/device has
        // since written {a: 'changed by another tab'} - this client's belief about the current state is stale.
        const staleHash = String(getStringHash(JSON.stringify({ a: 1 }, null, 4)));
        writeSettingsFile({ a: 'changed by another tab' });

        const response = await postSave({ a: 'clobber attempt' }, staleHash);

        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body.result).toBe('conflict');
        // The other tab's write must survive untouched - this is the actual bug the check exists to close.
        expect(readSettingsFile()).toEqual({ a: 'changed by another tab' });
    });

    test('treats a missing settings store as empty content for the conflict check', async () => {
        eraseSettings();
        // The canonical "no settings yet" serialization is the empty object, `"{}"` - see
        // readAllSettingsAsJson()'s own doc comment (settings-store.js) - not an empty string, since the
        // sharded store's canonical content is always a JSON.stringify() of the reconstructed object.
        const emptyHash = String(getStringHash(settingsStore.readAllSettingsAsJson(directories)));

        const matchingResponse = await postSave({ a: 'first save ever' }, emptyHash);
        expect(matchingResponse.status).toBe(200);
        expect(readSettingsFile()).toEqual({ a: 'first save ever' });
    });

    test('rejects a stale hash against a missing store when the client believed content existed', async () => {
        eraseSettings();
        const believedHash = String(getStringHash(JSON.stringify({ a: 'i think this exists' }, null, 4)));

        const response = await postSave({ a: 'clobber attempt' }, believedHash);

        expect(response.status).toBe(409);
        // The rejected write must not have applied - settings are still whatever they were before (empty).
        expect(readSettingsFile()).toEqual({});
    });

    test('treats a malformed hash header as absent and writes unconditionally', async () => {
        writeSettingsFile({ a: 'whatever was here' });

        const response = await postSave({ a: 'new value' }, 'not-a-number');

        expect(response.status).toBe(200);
        expect(readSettingsFile()).toEqual({ a: 'new value' });
    });
});
