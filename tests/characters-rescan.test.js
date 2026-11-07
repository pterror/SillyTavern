import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').convertedUser>>} */
let user;

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    user = await (await import('./converted-user.fixture.js')).convertedUser('characters-rescan-');
});

afterAll(async () => {
    await user.close();
});

/** @param {string} name */
async function cardPng(name) {
    const { write } = await import('../src/character-card-parser.js');
    const image = fs.readFileSync(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const card = { spec: 'chara_card_v2', spec_version: '2.0', name, data: { name, description: 'dropped in', first_mes: 'Hello.' } };
    return write(image, JSON.stringify(card));
}

describe('the scan of the characters folder when its watch starts', () => {
    test('leaves the files the conversion converted (a character deleted since included) and imports dropped and changed ones', async () => {
        const { TYPE } = await import('../src/library-codes.js');
        const { watchDroppedCharacters } = await import('../src/endpoints/characters.js');
        const lib = user.store.lib;
        await lib.deleteEntity(TYPE.character, 'Bob.png');
        await lib.deleteEntity(TYPE.character, 'Cara.png');
        fs.writeFileSync(path.join(user.directories.characters, 'Cara.png'), await cardPng('New Cara'));
        fs.writeFileSync(path.join(user.directories.characters, 'Dropped.png'), await cardPng('Dropped'));

        const watch = watchDroppedCharacters(user.directories);
        try {
            await watch.first;
        } finally {
            await watch.close();
        }
        const ids = await lib.ids(TYPE.character, ['Bob.png', 'Cara.png', 'Dropped.png']);
        expect(ids[0]).toBeNull();
        expect(ids[1]).not.toBeNull();
        expect(ids[2]).not.toBeNull();
    });
});
