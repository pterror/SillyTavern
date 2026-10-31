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
    test('the keys the server owns (background) are kept as stored and left out of the hash the page holds', async () => {
        writeSettingsFile({ a: 1, background: { name: 'mine.png' } });
        const pageHash = String(getStringHash(JSON.stringify({ a: 1 }, null, 4)));

        const saved = await postSave({ a: 2, background: { name: 'stale.png' } }, pageHash);
        expect(saved.status).toBe(200);
        expect(readSettingsFile()).toEqual({ a: 2, background: { name: 'mine.png' } });

        const { settingsHash } = await saved.json();
        settingsStore.writeNamedSettings(directories, { background: { name: 'other.png' } });
        const next = await postSave({ a: 3 }, String(settingsHash));
        expect(next.status).toBe(200);
        expect(readSettingsFile()).toEqual({ a: 3, background: { name: 'other.png' } });
        eraseSettings();
    });

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
        const staleHash = String(getStringHash(JSON.stringify({ a: 1 }, null, 4)));
        writeSettingsFile({ a: 'changed by another tab' });

        const response = await postSave({ a: 'clobber attempt' }, staleHash);

        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body.result).toBe('conflict');
        expect(readSettingsFile()).toEqual({ a: 'changed by another tab' });
    });

    test('treats a missing settings store as empty content for the conflict check', async () => {
        eraseSettings();
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
        expect(readSettingsFile()).toEqual({});
    });

    test('treats a malformed hash header as absent and writes unconditionally', async () => {
        writeSettingsFile({ a: 'whatever was here' });

        const response = await postSave({ a: 'new value' }, 'not-a-number');

        expect(response.status).toBe(200);
        expect(readSettingsFile()).toEqual({ a: 'new value' });
    });
});
