import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

const { router } = await import('./editor-presets.js');

/** @returns {{ app: import('express').Express, file: string }} */
function buildApp() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-editor-presets-test-'));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories: { root }, profile: { handle: 'tester' } };
        next();
    });
    app.use('/api/editor-presets', router);
    return { app, file: path.join(root, 'editor-presets.json') };
}

/**
 * @param {import('express').Express} app
 * @param {string} urlPath
 * @param {object} body
 */
async function post(app, urlPath, body) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/editor-presets${urlPath}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: res.status, data: await res.json().catch(() => ({})) };
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

test('a new user has no presets and no file is written by reading', async () => {
    const { app, file } = buildApp();
    const { status, data } = await post(app, '/get', {});
    assert.equal(status, 200);
    assert.deepEqual([data.presets, data.lists], [[], []]);
    assert.equal(fs.existsSync(file), false);
});

test('saving a preset mints its id, and the hash answers unchanged until something changes', async () => {
    const { app } = buildApp();
    const saved = await post(app, '/save-preset', { name: ' Dashes ', find: '—', flags: 'g', replace: '-' });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.preset.name, 'Dashes');
    assert.ok(saved.data.preset.id);
    const again = await post(app, '/get', { hash: saved.data.hash });
    assert.deepEqual(again.data, { unchanged: true, hash: saved.data.hash });
    const edited = await post(app, '/save-preset', { id: saved.data.preset.id, name: 'Dashes', find: '[—–]', flags: 'g', replace: '-' });
    assert.notEqual(edited.data.hash, saved.data.hash);
    const read = await post(app, '/get', { hash: saved.data.hash });
    assert.equal(read.data.presets[0].find, '[—–]');
});

test('saving a preset unchanged writes nothing', async () => {
    const { app, file } = buildApp();
    const saved = await post(app, '/save-preset', { name: 'a', find: 'a', flags: 'g', replace: 'b' });
    const before = fs.statSync(file).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 20));
    await post(app, '/save-preset', { id: saved.data.preset.id, name: 'a', find: 'a', flags: 'g', replace: 'b' });
    assert.equal(fs.statSync(file).mtimeMs, before);
});

test('a bad pattern, bad flags or a missing name is refused', async () => {
    const { app } = buildApp();
    assert.equal((await post(app, '/save-preset', { name: 'x', find: '(', flags: 'g', replace: '' })).status, 400);
    assert.equal((await post(app, '/save-preset', { name: 'x', find: 'a', flags: 'gg', replace: '' })).status, 400);
    assert.equal((await post(app, '/save-preset', { name: ' ', find: 'a', flags: 'g', replace: '' })).status, 400);
});

test('lists keep their order, and deleting a preset takes it out of every list', async () => {
    const { app } = buildApp();
    const a = (await post(app, '/save-preset', { name: 'a', find: 'a', flags: 'g', replace: '' })).data.preset;
    const b = (await post(app, '/save-preset', { name: 'b', find: 'b', flags: 'g', replace: '' })).data.preset;
    const list = (await post(app, '/save-list', { name: 'both', presetIds: [b.id, a.id, 'builtin:smart-quotes'] })).data.list;
    assert.deepEqual(list.presetIds, [b.id, a.id, 'builtin:smart-quotes']);
    await post(app, '/delete-preset', { id: b.id });
    const read = (await post(app, '/get', {})).data;
    assert.deepEqual(read.presets.map(p => p.id), [a.id]);
    assert.deepEqual(read.lists[0].presetIds, [a.id, 'builtin:smart-quotes']);
    assert.equal((await post(app, '/delete-list', { id: list.id })).data.deleted, true);
    assert.deepEqual((await post(app, '/get', {})).data.lists, []);
});
