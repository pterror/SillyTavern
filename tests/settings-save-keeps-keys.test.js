import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/settings-store.js')} */
let settingsStore;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;
let directories;

/**
 * The client's full-save payload has no `tags`, `tag_map` or `accountStorage`, so /save must not remove the key
 * files a payload leaves out. A snapshot restore is an explicit "exactly that state", so it still does.
 */
beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-settings-keeps-keys-test-'));
    fs.mkdirSync(path.join(tempDir, 'backups'), { recursive: true });
    directories = { root: tempDir, backups: path.join(tempDir, 'backups') };

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    settingsStore = await import('../src/settings-store.js');
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

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    settingsStore.deleteAllSettings(directories);
});

function keyFile(key) {
    return path.join(tempDir, 'settings', `${key}.json`);
}

/** @param {string} route @param {object} body */
function post(route, body) {
    return fetch(`${baseUrl}/api/settings/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('POST /api/settings/save keeps keys its payload does not name', () => {
    test('a full save without tags, tag_map and accountStorage leaves their files as they were', async () => {
        const tags = [{ id: '1345561466591', name: 'ST Default' }];
        const tagMap = { 'default_Seraphina.png': ['1345561466591'] };
        const accountStorage = { some_flag: 'true' };
        settingsStore.writeAllSettings(directories, { power_user: { theme: 'dark' }, tags, tag_map: tagMap, accountStorage });
        const before = ['tags', 'tag_map', 'accountStorage'].map(k => fs.readFileSync(keyFile(k), 'utf8'));

        const response = await post('save', { power_user: { theme: 'light' } });

        expect(response.status).toBe(200);
        expect(['tags', 'tag_map', 'accountStorage'].map(k => fs.readFileSync(keyFile(k), 'utf8'))).toEqual(before);
        expect(settingsStore.readAllSettings(directories)).toEqual({
            power_user: { theme: 'light' },
            tags,
            tag_map: tagMap,
            accountStorage,
        });
    });
});

describe('POST /api/settings/restore-snapshot stays a whole replace', () => {
    test('removes a key file the snapshot does not have', async () => {
        settingsStore.writeAllSettings(directories, { power_user: { theme: 'dark' }, extension_settings: { foo: 1 } });
        const name = 'settings_test-user_20260929-120000.json';
        fs.writeFileSync(path.join(tempDir, 'backups', name), JSON.stringify({ power_user: { theme: 'light' } }));

        const response = await post('restore-snapshot', { name });

        expect(response.status).toBe(204);
        expect(fs.existsSync(keyFile('extension_settings'))).toBe(false);
        expect(settingsStore.readAllSettings(directories)).toEqual({ power_user: { theme: 'light' } });
    });
});
