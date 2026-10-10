import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * A book's entries searched on the engine (`WorldInfoEngine.search`): upstream's `fuzzySearchWorldInfo` fields and
 * weights, prefixes only in `key` and `comment`, `uid` and `automationId` whole, characters' own books searched and
 * `originalData` not, pages through cursors, and a write found by the next search.
 */

/** @type {typeof import('../src/library-engine.js')} */
let lib;
/** @type {any} */
let engine;
/** @type {string} */
let tempDir;
/** @type {import('../src/library-engine.js').LibraryEngine} */
let library;
/** @type {import('../src/world-info-engine.js').WorldInfoEngine} */
let books;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    lib = await import('../src/library-engine.js');
    engine = (await import('../engine/load.js')).loadEngine().binding;
});

beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-world-info-search-test-'));
    library = await lib.LibraryEngine.open(engine, path.join(tempDir, 'store'));
    books = library.books;
});

afterEach(async () => {
    await library.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

const entry = (/** @type {number} */ uid, /** @type {Record<string, unknown>} */ fields) => ({ uid, key: [], keysecondary: [], comment: '', content: '', ...fields });

async function uids(/** @type {object} */ p) {
    const out = /** @type {any} */ (await books.search(/** @type {any} */ ({ limit: 50, ...p })));
    return out === 'missing' ? out : out.entries.map((/** @type {any} */ e) => e.uid);
}

describe('world-info search on the engine', () => {
    test('fields, weights, prefixes and whole matches', async () => {
        await books.write('Lore', {
            entries: {
                0: entry(0, { key: ['dragon'], content: 'a beast' }),
                1: entry(1, { comment: 'Dragons of the east', content: 'scales' }),
                2: entry(2, { content: 'a dragon sleeps here' }),
                3: entry(3, { keysecondary: ['dragon'], group: 'beasts' }),
                4: entry(4, { automationId: 'auto-7', content: 'x' }),
                17: entry(17, { content: 'seventeen' }),
            },
            originalData: { entries: [{ keys: ['dragon'], content: 'original dragon' }] },
        });
        // Key 20 outranks comment and keysecondary 10, which outrank content 3; the last word is a prefix in the
        // comment ("Dragons").
        const ranked = await uids({ name: 'Lore', search: 'dragon' });
        expect([ranked[0], [...ranked.slice(1, 3)].sort(), ranked[3], ranked.length]).toEqual(['0', ['1', '3'], '2', 4]);
        expect(await uids({ name: 'Lore', search: '"dragon"' })).toEqual(['0', '3', '2']);
        // A prefix in `key` and `comment` only.
        expect(await uids({ name: 'Lore', search: 'drag' })).toEqual(['0', '1']);
        expect(await uids({ name: 'Lore', search: 'beasts' })).toEqual(['3']);
        expect(await uids({ name: 'Lore', search: '17' })).toEqual(['17']);
        expect(await uids({ name: 'Lore', search: '1' })).toEqual(['1']);
        expect(await uids({ name: 'Lore', search: 'auto-7' })).toEqual(['4']);
        expect(await uids({ name: 'Lore', search: '"a dragon sleeps"' })).toEqual(['2']);
        expect(await uids({ name: 'Nope', search: 'dragon' })).toBe('missing');
    });

    test('a character\'s own book is searched', async () => {
        const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'C', character_book: { entries: [{ id: 3, keys: ['wyvern'], secondary_keys: [], comment: 'flying', content: 'scales', extensions: {} }] } } };
        const { id } = await library.writeCard({}, 'c.png', JSON.stringify(card), { dateAdded: 1 });
        expect(await uids({ character: id, search: 'wyv' })).toEqual(['0']);
        expect(await uids({ character: id, search: '3' })).toEqual(['0']);
        // Its `extensions`' `group` and `automation_id` (upstream's `group` and `automationId`) are searched, the id
        // whole; the card reads back as written, extension keys in their order.
        const ext = { foo: 'bar', automation_id: 'auto-9', group: 'drakes', position: 1 };
        const card2 = structuredClone(card);
        card2.data.character_book.entries.push({ id: 4, keys: [], secondary_keys: [], comment: '', content: 'x', extensions: ext });
        await library.writeCard({}, 'c.png', JSON.stringify(card2), { dateAdded: 1 });
        expect(await uids({ character: id, search: 'drakes' })).toEqual(['1']);
        expect(await uids({ character: id, search: 'auto-9' })).toEqual(['1']);
        expect(await uids({ character: id, search: 'drake' })).toEqual([], 'group is no prefix field');
        expect(JSON.stringify((await library.cards(['c.png']))[0].data.character_book)).toBe(JSON.stringify(card2.data.character_book));
        // A changed group writes that value alone, and the search follows it.
        const card3 = structuredClone(card2);
        card3.data.character_book.entries[1].extensions.group = 'wyrms';
        const { records } = await library.writeCard({}, 'c.png', JSON.stringify(card3), { dateAdded: 1 });
        expect(records).toBeLessThanOrEqual(2);
        expect(await uids({ character: id, search: 'drakes' })).toEqual([]);
        expect(await uids({ character: id, search: 'wyrms' })).toEqual(['1']);
        expect(await uids({ character: 999n, search: 'wyvern' })).toBe('missing');
    });

    test('pages read on through cursors, and a write is found by the next search', async () => {
        const entries = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i, entry(i, { content: `the tower ${i}` })]));
        await books.write('Big', { entries });
        const seen = [];
        const first = /** @type {any} */ (await books.search({ name: 'Big', search: 'tower', limit: 7 }));
        expect([first.total, first.totalExact]).toEqual([30, true]);
        let page = first;
        for (let i = 0; i < 10; i++) {
            seen.push(...page.entries.map((/** @type {any} */ e) => e.uid));
            if (!page.cursor) break;
            page = /** @type {any} */ (await books.search({ name: 'Big', search: 'tower', limit: 7, cursor: page.cursor }));
        }
        expect(seen.sort()).toEqual(Object.keys(entries).sort());
        await books.editEntry('Big', 5, entry(5, { content: 'the castle' }));
        expect(await uids({ name: 'Big', search: 'castle' })).toEqual(['5']);
        expect((await uids({ name: 'Big', search: 'tower' })).length).toBe(29);
        // Moved to another book: found there under its new key, and no longer in the first.
        await books.write('Other', { entries: {} });
        await books.transplant({ source: 'Big', target: 'Other', uid: 5, deleteOriginal: true });
        expect(await uids({ name: 'Big', search: 'castle' })).toEqual([]);
        expect(await uids({ name: 'Other', search: 'castle' })).toEqual(['0']);
    });
});
