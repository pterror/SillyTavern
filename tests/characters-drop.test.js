import { describe, test, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { setConfigFilePath } from '../src/util.js';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').convertedUser>>} */
let user;
/** @type {typeof import('../src/endpoints/characters.js')} */
let characters;
/** @type {typeof import('../src/library-codes.js')} */
let codes;
/** @type {import('node:http').Server} */
let server;
let base = '';
/** @type {ReturnType<typeof import('../src/endpoints/characters.js').watchDroppedCharacters>[]} */
const watches = [];

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    user = await (await import('./converted-user.fixture.js')).convertedUser('characters-drop-');
    characters = await import('../src/endpoints/characters.js');
    codes = await import('../src/library-codes.js');
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', characters.router);
    app.get('/ping', (_req, res) => res.send('pong'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterEach(async () => {
    await Promise.all(watches.splice(0).map(w => w.close()));
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

/** @param {string[]} avatars */
const present = async avatars => (await user.store.lib.ids(codes.TYPE.character, avatars)).map(id => id !== null);

const watch = (quietMs = 50) => {
    const w = characters.watchDroppedCharacters(user.directories, quietMs);
    watches.push(w);
    return w;
};

/** @param {() => Promise<boolean>} done */
async function until(done) {
    for (let i = 0; i < 200; i++) {
        if (await done()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('timed out');
}

describe('PNGs dropped into characters/', () => {
    test('the first pass imports files that are there, and leaves converted ones alone', async () => {
        const lib = user.store.lib;
        // Bob is deleted after the conversion; his PNG stays as the conversion found it.
        await lib.deleteEntity(codes.TYPE.character, 'Bob.png');
        fs.writeFileSync(path.join(user.directories.characters, 'Early.png'), await cardPng('Early'));
        const w = watch();
        await w.first;
        expect(await present(['Early.png', 'Bob.png'])).toEqual([true, false]);
    });

    test('a file dropped while running appears without a manual rescan; a converted file changed since is imported too', async () => {
        const w = watch();
        await w.first;
        fs.writeFileSync(path.join(user.directories.characters, 'Late.png'), await cardPng('Late'));
        await until(async () => (await present(['Late.png']))[0]);
        // Bob (converted, then deleted) is rewritten with another picture: no longer the converted file.
        fs.writeFileSync(path.join(user.directories.characters, 'Bob.png'), await cardPng('Bob again'));
        await until(async () => (await present(['Bob.png']))[0]);
        expect(await present(['Late.png', 'Bob.png'])).toEqual([true, true]);
    });

    test('a converted file touched without a change is not imported again', async () => {
        const lib = user.store.lib;
        await lib.deleteEntity(codes.TYPE.character, 'Cara.png');
        const w = watch();
        await w.first;
        const file = path.join(user.directories.characters, 'Cara.png');
        // Moved away and back: the watch reports it, its name, size and mtime stay.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        fs.renameSync(file, `${file}.away`);
        fs.renameSync(`${file}.away`, file);
        await new Promise(resolve => setTimeout(resolve, 300));
        await w.idle();
        const warned = warn.mock.calls.flat().map(String).join(' ');
        warn.mockRestore();
        // Reading it would fail (the conversion left no card in it) and say so.
        expect(warned).not.toContain('Cara.png');
        expect(await present(['Cara.png'])).toEqual([false]);
    });

    test('batches leave room for a concurrent request', async () => {
        const png = await cardPng('Many');
        for (let i = 0; i < 250; i++) fs.writeFileSync(path.join(user.directories.characters, `Many${i}.png`), png);
        const w = watch();
        let passDone = false;
        w.first.then(() => { passDone = true; });
        const started = Date.now();
        let answeredWhilePassing = false;
        while (!passDone && Date.now() - started < 60000) {
            const res = await fetch(`${base}/ping`);
            await res.arrayBuffer();
            if (!passDone) answeredWhilePassing = true;
            if (answeredWhilePassing) break;
        }
        expect(answeredWhilePassing).toBe(true);
        await w.first;
        expect((await present(Array.from({ length: 250 }, (_, i) => `Many${i}.png`))).every(Boolean)).toBe(true);
    }, 70000);
});
