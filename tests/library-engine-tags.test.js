import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Tags on the engine (src/library-engine.js, src/library-engine-tags.js) against the old store's answers for the
 * same writes.
 */

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/library-engine.js')} */
let lib;
/** @type {any} */
let engine;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;
/** @type {import('../src/library-engine.js').LibraryEngine} */
let library;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    lib = await import('../src/library-engine.js');
    engine = (await import('../engine/load.js')).loadEngine().binding;
});

beforeEach(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-library-engine-tags-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    library = await lib.LibraryEngine.open(engine, path.join(tempDir, 'store'));
});

afterEach(async () => {
    await library.close();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** The ids of a whole tagPage read, through pages of `limit`. */
async function pageIds(query, limit = 3) {
    const ids = [];
    let after;
    for (;;) {
        const page = await library.store.tagPage({ ...query, limit, ...(after ? { after } : {}) });
        ids.push(...page.ids);
        if (!page.cursor) return ids;
        after = page.cursor;
    }
}

describe('the tag writer', () => {
    test('a written tag is listed with its coerced order, and writing it again unchanged records nothing', async () => {
        const tags = [
            { id: 'a', name: 'Alpha', sort_order: 3 },
            { id: 'b', name: 'beta', sort_order: '1' },
            { id: 'c', name: 'Gamma', sort_order: null },
            { id: 'd', name: 'delta', sort_order: 'x' },
            { id: 'e', name: 'epsilon' },
        ];
        for (const tag of tags) await library.writeTag(tag);
        const keys = async (/** @type {bigint[]} */ ids) => (await library.store.tagKeys(ids)).map((/** @type {any} */ k) => k.key);
        // Manual: by order (null is 0), then the unordered by name.
        expect(await keys(await pageIds({ sort: 2 }))).toEqual(['c', 'b', 'a', 'd', 'e']);
        const before = library.store.stats().logBytes;
        for (const tag of tags) await library.writeTag(tag);
        expect(library.store.stats().logBytes).toBe(before);

        await library.writeTag({ id: 'e', name: 'epsilon', sort_order: -1 });
        await library.writeTag({ id: 'a', name: 'Alpha' });
        expect(await keys(await pageIds({ sort: 2 }))).toEqual(['e', 'c', 'b', 'a', 'd']);
        const [a] = await library.entities(await library.ids(lib.TYPE.tag, ['a']));
        expect(a?.tagOrder).toBeNull();
    });

    test('a key only assignments named is listed once its definition is written', async () => {
        await library.writeCard(directories, 'x.png', JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'x', data: { name: 'x' } }));
        const id = library.nextId++;
        const [character] = await library.ids(lib.TYPE.character, ['x.png']);
        await library.store.commit([{ kind: 'entityCreate', entity: id, type: lib.TYPE.tag, key: 'u', added: 1 }, { kind: 'tagAssign', entity: character, tag: id, assigned: true }]);
        expect(await pageIds({ sort: 0 })).toEqual([]);
        await library.writeTag({ id: 'u', name: 'Undefined until now', sort_order: 2 });
        expect(await pageIds({ sort: 2 })).toEqual([id]);
        expect((await library.store.tagCounts([id]))[0].count).toBe(1);
    });
});
