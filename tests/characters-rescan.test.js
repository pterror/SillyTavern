import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { setConfigFilePath } from '../src/util.js';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').convertedUser>>} */
let user;
/** @type {import('node:http').Server} */
let server;
let base = '';

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    user = await (await import('./converted-user.fixture.js')).convertedUser('characters-rescan-');
    const { router } = await import('../src/endpoints/characters.js');
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await user.close();
});

/** @param {string} name */
async function cardPng(name) {
    const { write } = await import('../src/character-card-parser.js');
    const image = fs.readFileSync(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const card = { spec: 'chara_card_v2', spec_version: '2.0', name, data: { name, description: 'dropped in', first_mes: 'Hello.' } };
    return write(image, JSON.stringify(card));
}

describe('POST /api/characters/metadata/rescan', () => {
    test('leaves the files the conversion converted (a character deleted since included) and imports dropped and changed ones', async () => {
        const { TYPE } = await import('../src/library-codes.js');
        const lib = user.store.lib;
        // Bob is deleted after the conversion; his old PNG stays in characters/ as the conversion found it.
        await lib.deleteEntity(TYPE.character, 'Bob.png');
        // Cara is deleted too, and a different file is then dropped under her name.
        await lib.deleteEntity(TYPE.character, 'Cara.png');
        fs.writeFileSync(path.join(user.directories.characters, 'Cara.png'), await cardPng('New Cara'));
        fs.writeFileSync(path.join(user.directories.characters, 'Dropped.png'), await cardPng('Dropped'));

        const res = await fetch(`${base}/api/characters/metadata/rescan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ imported: 2, skipped: 1, failed: [] });
        const ids = await lib.ids(TYPE.character, ['Bob.png', 'Cara.png', 'Dropped.png']);
        expect(ids[0]).toBeNull();
        expect(ids[1]).not.toBeNull();
        expect(ids[2]).not.toBeNull();
    });
});
