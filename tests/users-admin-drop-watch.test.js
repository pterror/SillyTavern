import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import storage from 'node-persist';

import { setConfigFilePath } from '../src/util.js';

/** @type {string} */
let dataRoot;
const cwd = process.cwd();
/** @type {import('node:http').Server} */
let server;
let base = '';
/** @type {typeof import('../src/user-stores.js')} */
let stores;

beforeAll(async () => {
    setConfigFilePath(path.join(cwd, '..', 'default', 'config.yaml'));
    stores = await import('../src/user-stores.js');
    const engine = (await import('../engine/load.js')).loadEngine().binding;
    stores.setStoreEngine(() => engine);
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'users-admin-drop-'));
    globalThis.DATA_ROOT = dataRoot;
    globalThis.GLOBAL_EXTENSIONS_PATH = path.join(dataRoot, '_extensions');
    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0 });
    const { router } = await import('../src/endpoints/users-admin.js');
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
        req.user = { profile: { handle: 'admin', admin: true } };
        next();
    });
    app.use('/api/users', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(async () => {
    process.chdir(cwd);
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await (await import('../src/endpoints/characters.js')).stopDroppedWatches();
    await stores.closeUserStores();
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

/** @param {string} url @param {object} body */
const post = async (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** @param {() => Promise<boolean>} done */
async function until(done) {
    for (let i = 0; i < 200; i++) {
        if (await done()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('timed out');
}

async function cardPng(/** @type {string} */ name) {
    const { write } = await import('../src/character-card-parser.js');
    const image = fs.readFileSync(path.join(cwd, '..', 'public', 'img', 'ai4.png'));
    return write(image, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name, data: { name, description: 'dropped in', first_mes: 'Hello.' } }));
}

describe('a user created while the server runs', () => {
    test('has dropped PNGs picked up until the user is deleted', async () => {
        const codes = await import('../src/library-codes.js');
        const { getUserDirectories } = await import('../src/users.js');
        // The public directories (relative paths) are made here, not in the repository.
        process.chdir(dataRoot);
        const created = await post('/api/users/create', { handle: 'newcomer', name: 'New' });
        process.chdir(cwd);
        expect(created.status).toBe(200);
        const directories = getUserDirectories('newcomer');
        fs.writeFileSync(path.join(directories.characters, 'Dropped.png'), await cardPng('Dropped'));
        const store = await stores.userStore(directories, 'newcomer');
        await until(async () => (await store.lib.ids(codes.TYPE.character, ['Dropped.png']))[0] !== null);

        expect((await post('/api/users/delete', { handle: 'newcomer' })).status).toBe(204);
        fs.writeFileSync(path.join(directories.characters, 'After.png'), await cardPng('After'));
        await new Promise(resolve => setTimeout(resolve, 1200));
        expect((await store.lib.ids(codes.TYPE.character, ['After.png']))[0]).toBeNull();
    });
});
