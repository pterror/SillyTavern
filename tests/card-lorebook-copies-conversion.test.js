import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/user-stores.js')} */
let stores;
/** @type {typeof import('../src/library-codes.js')} */
let codes;
/** @type {string[]} */
const made = [];

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    const engine = (await import('../engine/load.js')).loadEngine().binding;
    stores = await import('../src/user-stores.js');
    codes = await import('../src/library-codes.js');
    stores.setStoreEngine(() => engine);
});

afterAll(async () => {
    await stores.closeUserStores();
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const convert = (/** @type {string} */ root) => execFileSync(process.execPath, [path.join('..', 'scripts', 'convert-card-lorebook-copies.mjs'), '--data-root', root], { encoding: 'utf8' });

const cardBook = { name: 'Nia\'s Lorebook', entries: [{ id: 0, keys: ['inn'], content: 'An inn.', enabled: true, insertion_order: 100, extensions: {} }] };

/**
 * @param {string} name
 * @param {string} world
 */
const card = (name, world) => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name, data: { name, description: '', extensions: { world }, character_book: cardBook } });

/**
 * @param {import('../src/library-engine.js').LibraryEngine} lib
 * @param {string} name
 * @param {Record<string, unknown>} data
 */
async function storeCardCopy(lib, name, data) {
    const id = lib.nextId++;
    /** @type {object[]} */
    const keyed = [];
    const records = await lib.books.bookRecords(id, null, data, { world: true }, await lib.books.stamper(null, keyed));
    records.unshift({ kind: 'entityCreate', entity: id, type: codes.TYPE.book, key: name, added: Date.now() });
    await lib.store.commit([...keyed, ...records]);
    return id;
}

test('every world made from a card\'s book is deleted, edited or not, with the links to it; the cards keep their own books', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'st-card-copies-conversion-'));
    made.push(data);
    const root = path.join(data, 'u');
    const directories = /** @type {any} */ ({ root });
    const store = await stores.userStore(directories);
    const { lib } = store;
    const copy = await storeCardCopy(lib, 'Nia\'s Lorebook', {
        entries: { 0: { uid: 0, key: ['inn', 'tavern'], content: 'An inn, edited since.', comment: 'Inn' }, 1: { uid: 1, key: ['river'], content: 'Added since.' } },
        originalData: cardBook,
    });
    await storeCardCopy(lib, 'Nia\'s Lorebook (copy)', { entries: { 0: { uid: 0, key: ['inn'], content: 'An inn.' } }, originalData: cardBook });
    await lib.books.write('Plain', { entries: { 0: { uid: 0, key: ['road'], content: 'A road.' } } });
    await lib.writeCard(directories, 'nia', card('Nia', 'Nia\'s Lorebook'));
    await lib.writeCard(directories, 'ilse', card('Ilse', 'Plain'));
    await lib.extraLinks('ilse', 'add', ['Nia\'s Lorebook']);
    const [original] = await lib.ids(codes.TYPE.ownedBook, [`${copy}:o`]);
    expect(original).not.toBeNull();
    await stores.closeUserStores();

    const marker = path.join(root, stores.STORE_DIR, stores.CARD_BOOK_COPIES_DELETED);
    fs.rmSync(marker);
    expect(await stores.oldFormatLine({ root })).toBe(`${root} has lorebooks made from a character's own lorebook (by "Import Card Lore"): run node scripts/convert-card-lorebook-copies.mjs --data-root <the folder holding it> once, with the server stopped`);
    await expect(stores.userStore(directories)).rejects.toThrow('convert-card-lorebook-copies.mjs');

    expect(convert(data)).toBe('Users: 1 (0 already converted). Lorebooks looked at: 3. Deleted as copies of a character\'s own lorebook: 2. Characters unlinked from them: 2. Chats unlinked from them: 0.\n');
    expect(fs.existsSync(marker)).toBe(true);
    expect(await stores.oldFormatLine({ root })).toBeNull();

    const after = await stores.userStore(directories);
    expect((await after.lib.books.list()).map(b => b.file_id)).toEqual(['Plain']);
    expect((await after.lib.entities([copy, /** @type {bigint} */ (original)])).every(e => e === null)).toBe(true);
    const [nia, ilse] = /** @type {any[]} */ (await after.lib.cards(['nia', 'ilse']));
    expect(nia.data.extensions.world).toBeUndefined();
    expect(nia.data.character_book).toEqual(cardBook);
    expect(ilse.data.extensions.world).toBe('Plain');
    expect(ilse.data.character_book).toEqual(cardBook);
    expect(await after.lib.extraBookNames('ilse')).toEqual([]);
    await stores.closeUserStores();

    expect(convert(data)).toBe('Users: 1 (1 already converted). Lorebooks looked at: 0. Deleted as copies of a character\'s own lorebook: 0. Characters unlinked from them: 0. Chats unlinked from them: 0.\n');
});
