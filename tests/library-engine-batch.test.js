import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';

/** @type {any} */
let engine;
/** @type {typeof import('../src/library-engine.js')} */
let libMod;
/** @type {(() => Promise<void>)[]} */
const cleanups = [];

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    engine = (await import('../engine/load.js')).loadEngine().binding;
    libMod = await import('../src/library-engine.js');
});

afterEach(async () => {
    while (cleanups.length) await /** @type {() => Promise<void>} */ (cleanups.pop())();
});

async function openLibrary() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-batch-'));
    /** @type {any} */
    const directories = { root };
    for (const [k, v] of Object.entries(USER_DIRECTORY_TEMPLATE)) directories[k] = path.join(root, /** @type {string} */ (v));
    const lib = await libMod.LibraryEngine.open(engine, path.join(root, 'store'));
    let commits = 0;
    const commit = lib.store.commit.bind(lib.store);
    lib.store.commit = (/** @type {object[]} */ records) => {
        commits++;
        return commit(records);
    };
    cleanups.push(async () => {
        await lib.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { lib, directories, commits: () => commits };
}

/** @param {number} i */
const card = i => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: `C${i}`, data: { name: `C${i}`, description: `card ${i}`, first_mes: 'Hi.' } });

describe('batch imports', () => {
    test('card writes arriving together in a batch share commits, each answered once stored', async () => {
        const { lib, directories, commits } = await openLibrary();
        lib.beginBatch();
        const n = 12;
        await Promise.all(Array.from({ length: n }, (_, i) => lib.writeCard(directories, `c${i}.png`, card(i))));
        lib.endBatch();
        expect(commits()).toBeLessThan(n);
        const ids = await lib.ids(libMod.TYPE.character, Array.from({ length: n }, (_, i) => `c${i}.png`));
        expect(ids.every(id => id !== null)).toBe(true);
        const cards = await lib.cards(Array.from({ length: n }, (_, i) => `c${i}.png`));
        expect(cards.map(c => /** @type {any} */ (c).data.description)).toEqual(Array.from({ length: n }, (_, i) => `card ${i}`));
    });

    test('outside a batch each card is its own commit', async () => {
        const { lib, directories, commits } = await openLibrary();
        await Promise.all(Array.from({ length: 4 }, (_, i) => lib.writeCard(directories, `c${i}.png`, card(i))));
        expect(commits()).toBe(4);
    });

    test('a refused write in a group fails alone; the others are stored', async () => {
        const { lib, directories } = await openLibrary();
        lib.beginBatch();
        await lib.writeCard(directories, 'a.png', card(0));
        const [a] = await lib.ids(libMod.TYPE.character, ['a.png']);
        const results = await Promise.allSettled([
            lib.cardCommits.commit([{ kind: 'entityCreate', entity: lib.nextId++, type: libMod.TYPE.character, key: 'a.png', added: 1 }]),
            lib.writeCard(directories, 'b.png', card(1)),
            lib.writeCard(directories, 'c.png', card(2)),
        ]);
        lib.endBatch();
        expect(results.map(r => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
        const ids = await lib.ids(libMod.TYPE.character, ['a.png', 'b.png', 'c.png']);
        expect(ids[0]).toBe(a);
        expect(ids[1]).not.toBeNull();
        expect(ids[2]).not.toBeNull();
    });
});
