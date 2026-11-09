import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/user-stores.js')} */
let stores;
/** @type {any} */
let engine;
/** @type {string[]} */
const made = [];

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    engine = (await import('../engine/load.js')).loadEngine().binding;
    stores = await import('../src/user-stores.js');
    stores.setStoreEngine(() => engine);
});

afterAll(async () => {
    await stores.closeUserStores();
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function dataRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-worldbuilding-conversion-'));
    made.push(dir);
    return dir;
}

const convert = (/** @type {string} */ root) => execFileSync(process.execPath, [path.join('..', 'scripts', 'convert-lorebooks-to-worldbuilding.mjs'), '--data-root', root], { encoding: 'utf8' });

test('a store without the worldbuilding marker is refused, naming the script; a new store has it and opens', async () => {
    const data = dataRoot();
    const root = path.join(data, 'u');
    const dir = path.join(root, stores.STORE_DIR);
    const { LibraryEngine } = await import('../src/library-engine.js');
    const lib = await LibraryEngine.open(engine, dir);
    await lib.close();
    for (const marker of [stores.GREETINGS_BY_ID, stores.GREETING_LINKS, stores.GREETINGS_UNIQUE]) fs.writeFileSync(path.join(dir, marker), '');
    const line = await stores.oldFormatLine({ root });
    expect(line).toBe(`${root} has lorebooks whose entries aren't yet ordered, linked and counted for worldbuilding: run node scripts/convert-lorebooks-to-worldbuilding.mjs --data-root <the folder holding it> once, with the server stopped`);
    await expect(stores.assertConverted([{ root }])).rejects.toThrow(stores.OldFormatError);
    await expect(stores.userStore({ root })).rejects.toThrow('convert-lorebooks-to-worldbuilding.mjs');
    expect(() => stores.engineStoreHere({ root })).toThrow(stores.OldFormatError);

    const fresh = path.join(data, 'v');
    fs.mkdirSync(fresh);
    await stores.userStore({ root: fresh });
    for (const marker of stores.WORLDBUILDING_MARKERS) expect(fs.existsSync(path.join(fresh, stores.STORE_DIR, marker))).toBe(true);
    expect(await stores.oldFormatLine({ root: fresh })).toBeNull();
    await stores.closeUserStores();
});

test('the script converts a store without the markers, keeps its counts, lists and names, writes the markers, and skips the store after', async () => {
    const data = dataRoot();
    const root = path.join(data, 'u');
    const store = await stores.userStore({ root });
    await store.lib.books.write('Imported', {
        entries: {
            0: { uid: 0, key: ['Ilse', 'lamp'], comment: 'Ilse', content: 'Ilse keeps the lamp of Varro.', displayIndex: 0 },
            1: { uid: 1, key: ['Ilse', 'house'], comment: 'The House', content: 'A house.', displayIndex: 1 },
            2: { uid: 2, key: ['Varro'], comment: 'Varro', content: 'Varro.', displayIndex: 2, extensions: { names: ['Varro'] } },
        },
    });
    const { id: book } = /** @type {{ id: bigint }} */ (await store.lib.books.find('Imported'));
    const entities = (await store.lib.books.storedEntries(book)).map(({ entity }) => entity.id);
    const counts = async (/** @type {any} */ lib) => ({
        offer: await lib.books.namesOffer(book),
        keys: await Promise.all(entities.map(async entry => (await lib.store.worldRead('worldbuildingEntry', { book, entry })).keys)),
        sharers: await lib.store.worldRead('worldbuildingKeySharers', { book, entry: entities[0], key: 'Ilse', limit: 5 }),
        links: (await lib.store.worldRead('textLinkCandidates', { book, entry: entities[0], text: 'Ilse keeps the lamp of Varro.', readsAtMost: 1000 })).candidates,
    });
    const before = await counts(store.lib);
    expect(before.offer).toMatchObject({ namedEntries: 1, offeredEntries: 1 });
    expect(before.keys[0]).toEqual([{ text: 'Ilse', isName: false, alsoBringsUp: 1 }, { text: 'lamp', isName: false, alsoBringsUp: 0 }]);
    expect(before.sharers).toEqual({ entries: [{ thing: String(entities[1]), text: 'The House', shownAs: 'title' }], more: false });
    expect(before.links).toEqual([{ entry: entities[2], names: ['Varro'], caseSensitive: null, matchWholeWords: null }]);
    await stores.closeUserStores();

    const markers = stores.WORLDBUILDING_MARKERS.map(marker => path.join(root, stores.STORE_DIR, marker));
    for (const marker of markers) fs.rmSync(marker);
    expect(await stores.oldFormatLine({ root })).toContain('convert-lorebooks-to-worldbuilding.mjs');
    expect(convert(data)).toContain('Users: 1 (0 already converted). Relations fields rewritten to name targets by entity: 0. Steps of 2000 entries: 1.');
    for (const marker of markers) expect(fs.existsSync(marker)).toBe(true);
    expect(await stores.oldFormatLine({ root })).toBeNull();
    expect(convert(data)).toContain('Users: 1 (1 already converted). Relations fields rewritten to name targets by entity: 0. Steps of 2000 entries: 0.');

    fs.rmSync(markers[1]);
    expect(await stores.oldFormatLine({ root })).toContain('convert-lorebooks-to-worldbuilding.mjs');
    expect(convert(data)).toContain('Users: 1 (0 already converted).');
    const after = await stores.userStore({ root });
    expect(await counts(after.lib)).toEqual(before);
    await stores.closeUserStores();
});
