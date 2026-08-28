import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {import('express').Router} */
let router;
/** @type {(obj: Record<string, unknown>, keys: string[]) => Record<string, number>} */
let hashSettingsKeys;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;
let settingsPath;

/**
 * Mounts the real settings.js router, same shape as settings-save-conflict.test.js. Covers /api/settings/save-
 * partial: the read-modify-write merge endpoint, its per-key conflict check, and (the point of this file) that
 * concurrent partial updates racing each other never corrupt the file or silently lose a write - see the
 * "concurrent partial updates" describe block below.
 */
beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-settings-save-partial-test-'));
    fs.mkdirSync(path.join(tempDir, 'backups'), { recursive: true });
    settingsPath = path.join(tempDir, 'settings.json');

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ hashSettingsKeys } = await import('../public/scripts/hash-utils.js'));
    ({ router } = await import('../src/endpoints/settings.js'));
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = {
            directories: { root: tempDir, backups: path.join(tempDir, 'backups') },
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
 * @param {object} keys
 * @param {Record<string, number>} [expectedHashes]
 */
async function postPartialSave(keys, expectedHashes) {
    return fetch(`${baseUrl}/api/settings/save-partial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(expectedHashes ? { keys, expectedHashes } : { keys }),
    });
}

function writeSettingsFile(obj) {
    const content = JSON.stringify(obj, null, 4);
    fs.writeFileSync(settingsPath, content, 'utf8');
    return content;
}

function readSettingsFile() {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

describe('POST /api/settings/save-partial', () => {
    test('merges the sent keys into existing content, leaving other keys untouched', async () => {
        writeSettingsFile({ power_user: { theme: 'dark' }, extension_settings: { foo: 1 }, unrelated: 'kept' });

        const response = await postPartialSave({ power_user: { theme: 'light' } });

        expect(response.status).toBe(200);
        expect(readSettingsFile()).toEqual({
            power_user: { theme: 'light' },
            extension_settings: { foo: 1 },
            unrelated: 'kept',
        });
    });

    test('treats a missing settings file as an empty object to merge into', async () => {
        fs.rmSync(settingsPath, { force: true });

        const response = await postPartialSave({ power_user: { theme: 'dark' } });

        expect(response.status).toBe(200);
        expect(readSettingsFile()).toEqual({ power_user: { theme: 'dark' } });
    });

    test('rejects with 400 when "keys" is missing or not an object', async () => {
        const missing = await fetch(`${baseUrl}/api/settings/save-partial`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(missing.status).toBe(400);

        const arrayBody = await fetch(`${baseUrl}/api/settings/save-partial`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: ['not', 'an', 'object'] }),
        });
        expect(arrayBody.status).toBe(400);
    });

    test('proceeds unconditionally when expectedHashes is omitted (backward compatible)', async () => {
        writeSettingsFile({ power_user: { theme: 'dark' } });

        const response = await postPartialSave({ power_user: { theme: 'anything' } });

        expect(response.status).toBe(200);
        expect(readSettingsFile()).toEqual({ power_user: { theme: 'anything' } });
    });

    test('proceeds when expectedHashes matches the current value of the touched key', async () => {
        const current = writeSettingsFile({ power_user: { theme: 'dark' }, extension_settings: { foo: 1 } });
        const currentObj = JSON.parse(current);
        const expectedHashes = hashSettingsKeys(currentObj, ['power_user']);

        const response = await postPartialSave({ power_user: { theme: 'light' } }, expectedHashes);

        expect(response.status).toBe(200);
        expect(readSettingsFile().power_user).toEqual({ theme: 'light' });
    });

    test('rejects with 409 and leaves the file untouched when the touched key has changed', async () => {
        writeSettingsFile({ power_user: { theme: 'dark' } });
        // Client believes power_user is still what it saw a while ago, but someone else already changed it.
        const staleHashes = hashSettingsKeys({ power_user: { theme: 'stale belief' } }, ['power_user']);
        const actualContent = writeSettingsFile({ power_user: { theme: 'changed by another tab' } });

        const response = await postPartialSave({ power_user: { theme: 'clobber attempt' } }, staleHashes);

        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body.result).toBe('conflict');
        expect(body.conflictingKeys).toEqual(['power_user']);
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe(actualContent);
    });

    test('does NOT reject when the conflicting change is to a key this update never touched', async () => {
        // This is the actual point of per-key (vs whole-file) conflict detection: a concurrent change to some
        // unrelated key must not block an update to a different key.
        const original = writeSettingsFile({ power_user: { theme: 'dark' }, extension_settings: { foo: 1 } });
        const believedHashes = hashSettingsKeys(JSON.parse(original), ['power_user']);
        // Someone else changes extension_settings (a key this call never mentions) in between.
        writeSettingsFile({ power_user: { theme: 'dark' }, extension_settings: { foo: 999 } });

        const response = await postPartialSave({ power_user: { theme: 'light' } }, believedHashes);

        expect(response.status).toBe(200);
        expect(readSettingsFile()).toEqual({ power_user: { theme: 'light' }, extension_settings: { foo: 999 } });
    });
});

describe('POST /api/settings/save-partial concurrent updates', () => {
    test('two disjoint concurrent updates against the same baseline both succeed and both persist', async () => {
        const baseline = writeSettingsFile({ power_user: { theme: 'dark' }, extension_settings: { foo: 1 } });
        const baselineObj = JSON.parse(baseline);
        const hashesA = hashSettingsKeys(baselineObj, ['power_user']);
        const hashesB = hashSettingsKeys(baselineObj, ['extension_settings']);

        const [responseA, responseB] = await Promise.all([
            postPartialSave({ power_user: { theme: 'light' } }, hashesA),
            postPartialSave({ extension_settings: { foo: 2 } }, hashesB),
        ]);

        expect(responseA.status).toBe(200);
        expect(responseB.status).toBe(200);
        // Node serializes each synchronous handler body start-to-finish (see save-partial's own doc comment on
        // this), so both requests' read-modify-write halves run one at a time - neither can silently overwrite
        // the other's merge, regardless of what order they land in.
        expect(readSettingsFile()).toEqual({ power_user: { theme: 'light' }, extension_settings: { foo: 2 } });
    });

    test('two overlapping concurrent updates against the same baseline: exactly one succeeds, the other 409s, and the file is never corrupted or silently overwritten', async () => {
        const baseline = writeSettingsFile({ power_user: { theme: 'dark' } });
        const baselineObj = JSON.parse(baseline);
        // Both requests believe the same starting state for the *same* key.
        const sharedExpectedHashes = hashSettingsKeys(baselineObj, ['power_user']);

        const [responseA, responseB] = await Promise.all([
            postPartialSave({ power_user: { theme: 'set-by-A' } }, sharedExpectedHashes),
            postPartialSave({ power_user: { theme: 'set-by-B' } }, sharedExpectedHashes),
        ]);

        const statuses = [responseA.status, responseB.status].sort();
        // Whichever request's synchronous handler body ran first changes the on-disk hash before the second
        // one's per-key check runs, so the second one's belief about power_user is now stale - the same
        // mechanism that makes the "no lost update" guarantee hold. Never both succeed (one would silently
        // clobber the other's write, exactly the original bug), and never both fail (that would mean nothing
        // ever gets through under contention).
        expect(statuses).toEqual([200, 409]);

        const finalState = readSettingsFile();
        expect(['set-by-A', 'set-by-B']).toContain(finalState.power_user.theme);

        const winner = responseA.status === 200 ? 'set-by-A' : 'set-by-B';
        expect(finalState.power_user.theme).toBe(winner);
    });
});

describe('POST /api/settings/save-partial dotted-path keys', () => {
    test('dotted key sets a nested value without replacing the parent object', async () => {
        writeSettingsFile({ power_user: { theme: 'dark', font_scale: 1 } });

        const response = await postPartialSave({ 'power_user.font_scale': 1.5 });

        expect(response.status).toBe(200);
        expect(readSettingsFile()).toEqual({
            power_user: { theme: 'dark', font_scale: 1.5 },
        });
    });

    test('dotted key creates intermediate objects when they do not exist', async () => {
        writeSettingsFile({ unrelated: 'kept' });

        const response = await postPartialSave({ 'power_user.font_scale': 1.5 });

        expect(response.status).toBe(200);
        expect(readSettingsFile()).toEqual({
            unrelated: 'kept',
            power_user: { font_scale: 1.5 },
        });
    });

    test('dotted key conflict detection rejects when the nested value changed', async () => {
        writeSettingsFile({ power_user: { theme: 'dark', font_scale: 1 } });
        const staleHashes = hashSettingsKeys({ power_user: { theme: 'dark', font_scale: 0.8 } }, ['power_user.font_scale']);

        const response = await postPartialSave({ 'power_user.font_scale': 1.5 }, staleHashes);

        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body.conflictingKeys).toEqual(['power_user.font_scale']);
    });

    test('dotted key succeeds when only a sibling nested field changed', async () => {
        const original = writeSettingsFile({ power_user: { theme: 'dark', font_scale: 1 } });
        const expectedHashes = hashSettingsKeys(JSON.parse(original), ['power_user.font_scale']);
        writeSettingsFile({ power_user: { theme: 'light', font_scale: 1 } });

        const response = await postPartialSave({ 'power_user.font_scale': 1.5 }, expectedHashes);

        expect(response.status).toBe(200);
        expect(readSettingsFile()).toEqual({
            power_user: { theme: 'light', font_scale: 1.5 },
        });
    });

    test('mixed dotted and top-level keys in a single request both apply correctly', async () => {
        writeSettingsFile({ power_user: { theme: 'dark', font_scale: 1 }, main_api: 'kobold' });

        const response = await postPartialSave({
            'power_user.font_scale': 1.5,
            main_api: 'openai',
        });

        expect(response.status).toBe(200);
        expect(readSettingsFile()).toEqual({
            power_user: { theme: 'dark', font_scale: 1.5 },
            main_api: 'openai',
        });
    });

    test('two concurrent dotted-key updates to different sub-fields both succeed', async () => {
        const baseline = writeSettingsFile({ power_user: { theme: 'dark', font_scale: 1, blur_strength: 10 } });
        const baselineObj = JSON.parse(baseline);
        const hashesA = hashSettingsKeys(baselineObj, ['power_user.font_scale']);
        const hashesB = hashSettingsKeys(baselineObj, ['power_user.blur_strength']);

        const [responseA, responseB] = await Promise.all([
            postPartialSave({ 'power_user.font_scale': 2 }, hashesA),
            postPartialSave({ 'power_user.blur_strength': 20 }, hashesB),
        ]);

        expect(responseA.status).toBe(200);
        expect(responseB.status).toBe(200);
        expect(readSettingsFile()).toEqual({
            power_user: { theme: 'dark', font_scale: 2, blur_strength: 20 },
        });
    });
});
