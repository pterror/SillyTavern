import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * The library on the engine (src/library-engine.js) against the old store's answers for the same writes: cards,
 * list rows, and /query pages and totals.
 */

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/library-engine.js')} */
let lib;
/** @type {typeof import('../src/character-card-storage.js')} */
let storage;
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
    storage = await import('../src/character-card-storage.js');
    engine = (await import('../engine/load.js')).loadEngine().binding;
});

beforeEach(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-library-engine-test-'));
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

/** A deterministic stream of numbers in [0, 1). */
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// No lone surrogates: the old store's SQLite text turns them into U+FFFD (the engine keeps them; tested below).
const NAMES = ['Ana', 'bob', 'Émile', 'zed', 'ana', 'Ölaf', 'carl', 'Σίσυφος', ''];
const DATES = ['2024-07-12@01h31m37s123ms', 'March 7, 2023', 'not a date', 1_700_000_000_000, '', undefined, '2021-01-01T00:00:00Z'];
const TAG_IDS = ['t-red', 't-blue', 't-green'];

/** A varied card: V2 or V1, greetings, card tags, extensions, odd dates, unknown keys. */
function makeCard(r, i) {
    const pick = (/** @type {any[]} */ list) => list[Math.floor(r() * list.length)];
    const name = pick(NAMES);
    const description = Array.from({ length: 5 + Math.floor(r() * 30) }, () => pick(['the', 'dragon', 'quiet', 'knight', '😀', 'é'])).join(' ');
    const createDate = pick(DATES);
    if (r() < 0.25) {
        return { name, description, personality: 'p', first_mes: 'hi', mes_example: '', scenario: '', tags: r() < 0.5 ? 'a, b' : ['x'], ...(createDate === undefined ? {} : { create_date: createDate }), creatorcomment: 'note' };
    }
    const data = {
        name,
        description,
        personality: '',
        scenario: 's',
        first_mes: 'Hello',
        mes_example: '',
        creator_notes: 'cn',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: Array.from({ length: Math.floor(r() * 4) }, (_, k) => `alt ${k} ${i}`),
        tags: r() < 0.5 ? ['card-tag', `t${i % 3}`] : [],
        creator: r() < 0.5 ? 'someone' : '',
        character_version: '1.0',
        extensions: { talkativeness: '0.5', world: r() < 0.4 ? 'lore' : '', depth_prompt: { depth: 4, prompt: 'x' }, ...(r() < 0.3 ? { fav: false } : {}) },
        ...(r() < 0.2 ? { group_only_greetings: ['only'] } : {}),
        ...(r() < 0.2 ? { creation_date: 1700000000 + i } : {}),
    };
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name,
        description,
        data,
        ...(createDate === undefined ? {} : { create_date: createDate }),
        ...(r() < 0.2 ? { unknown_top: { a: [1, 2] } } : {}),
    };
}

/** Writes each card to both stores, with the same date added, fav and tags. */
async function writeBoth(entries) {
    for (const { avatar, card, fav, tags, added } of entries) {
        const json = JSON.stringify(card);
        await metadataDb.upsertCharacterFromWrite(directories, avatar, json);
        await metadataDb.setCharacterDateAdded(directories, avatar, added);
        await metadataDb.setCharacterFav(directories, avatar, fav);
        await library.writeCard(directories, avatar, json, { dateAdded: added });
        await library.setFav(lib.TYPE.character, avatar, fav);
        for (const t of tags) {
            await metadataDb.assignEntityTag(directories, avatar, t);
            await library.assignTag(lib.TYPE.character, avatar, t, true);
        }
    }
}

async function setUpTags() {
    for (const id of TAG_IDS) {
        await metadataDb.createTagDefinition(directories, { id, name: id });
        await library.writeTag({ id, name: id });
    }
}

function library50(seed = 1) {
    const r = rng(seed);
    return Array.from({ length: 50 }, (_, i) => ({
        avatar: `char-${String(Math.floor(r() * 1000)).padStart(3, '0')}-${i}.png`,
        card: makeCard(r, i),
        fav: r() < 0.3,
        tags: TAG_IDS.filter(() => r() < 0.35),
        added: 1_000_000 + Math.floor(r() * 40) * 1000,
    }));
}

const QUERIES = [
    {},
    { fav: true },
    { tags: { include: ['t-red'] } },
    { tags: { include: ['t-red', 't-blue'] } },
    { tags: { include: ['t-red', 't-green'], mode: 'or' } },
    { tags: { exclude: ['t-blue'] } },
    { world: 'lore' },
    { ranges: { data_size: { min: 50, max: 150 } } },
    { ranges: { create_date: { min: 1_600_000_000_000 } } },
    { ids: ['nobody.png'] },
];
const SORTS = [
    ['name', 'asc'], ['name', 'desc'], ['create_date', 'desc'], ['create_date', 'asc'], ['date_added', 'asc'],
    ['date_added', 'desc'], ['data_size', 'desc'], ['data_size', 'asc'], ['fav', 'desc'], ['fav', 'asc'],
    ['chat_size', 'desc'], ['date_last_chat', 'desc'],
];

/** Every id of a query, both stores, through pages of 7. */
async function bothPages(filter, sortField, sortOrder) {
    const read = async (/** @type {(p: any) => Promise<any>} */ query) => {
        const ids = [];
        let cursor;
        let total;
        let approx;
        for (let page = 0; page < 20; page++) {
            const r = await query({ ...filter, sortField, sortOrder, seed: 9, limit: 7, offset: cursor ? 0 : ids.length, cursor, wantTotal: page === 0 });
            if (page === 0) {
                total = r.total;
                approx = r.approxTotal;
            }
            ids.push(...r.rows.map(row => row.id));
            if (r.rows.length < 7) break;
            cursor = r.cursor;
        }
        return { ids, total, approx };
    };
    const old = await read(p => metadataDb.queryEntities(directories, p));
    const eng = await read(p => library.query(p));
    return { old, eng };
}

describe('the library on the engine', () => {
    test('cards read back as the old store has them, and rewriting one unchanged records nothing', async () => {
        await setUpTags();
        const entries = library50();
        await writeBoth(entries);
        const cards = await library.cards(entries.map(e => e.avatar));
        for (const [i, { avatar, card, fav }] of entries.entries()) {
            const old = JSON.parse(/** @type {string} */ (await metadataDb.getCharacterCardJson(directories, avatar)));
            expect(storage.canonicalCardHash(cards[i])).toBe(storage.canonicalCardHash(old));
            expect(storage.canonicalCardHash(cards[i])).toBe(storage.canonicalCardHash(storage.cardWithStoredFav(card, fav)));
            const again = await library.writeCard(directories, avatar, JSON.stringify(card));
            expect(again.records).toBe(0);
        }
    });

    test('list rows are the old store\'s', async () => {
        await setUpTags();
        const entries = library50(2);
        await writeBoth(entries);
        const avatars = entries.map(e => e.avatar);
        const old = await metadataDb.getShallowByIds(directories, avatars);
        const ents = await library.entities(await library.ids(lib.TYPE.character, avatars));
        const rows = await library.listRows(/** @type {any[]} */ (ents), false);
        for (const [i, avatar] of avatars.entries()) {
            expect(rows[i]).toEqual(old[avatar]);
        }
    });

    test('query pages and totals are the old store\'s, through cursors', async () => {
        await setUpTags();
        await writeBoth(library50(3));
        for (const filter of QUERIES) {
            for (const [field, order] of SORTS) {
                const { old, eng } = await bothPages(filter, field, order);
                expect({ filter, field, order, ids: eng.ids }).toEqual({ filter, field, order, ids: old.ids });
                // A total either store marks as an estimate isn't compared; an exact one is every match.
                const exact = !old.approx && !eng.approx;
                expect(exact ? eng.total : null).toBe(exact ? old.total : null);
                expect(eng.approx || eng.total === eng.ids.length).toBe(true);
            }
            const { old, eng } = await bothPages(filter, 'random', 'asc');
            expect([...eng.ids].sort()).toEqual([...old.ids].sort());
        }
    });

    test('edits write only what changed and read back as the old store\'s after them', async () => {
        await setUpTags();
        const entries = library50(4).filter(e => e.card.spec);
        await writeBoth(entries);
        const r = rng(99);
        const before = library.store.stats().logBytes;
        let records = 0;
        for (const e of entries) {
            const card = structuredClone(e.card);
            const kind = Math.floor(r() * 4);
            if (kind === 0) card.data.description = card.data.description.replace(/ /, ' brave ');
            if (kind === 1) card.data.alternate_greetings.splice(0, 0, 'new first');
            if (kind === 2) card.data.alternate_greetings.pop();
            if (kind === 3) card.data.extensions.depth_prompt.depth = 5;
            card.description = card.data.description;
            e.card = card;
            const json = JSON.stringify(card);
            await metadataDb.upsertCharacterFromWrite(directories, e.avatar, json);
            records += (await library.writeCard(directories, e.avatar, json)).records;
        }
        // At most a few records per edit: the value, the item, and the sort keys and hash that moved with it.
        expect(records).toBeLessThan(entries.length * 6);
        expect(library.store.stats().logBytes - before).toBeLessThan(entries.length * 200);
        const cards = await library.cards(entries.map(e => e.avatar));
        for (const [i, { avatar }] of entries.entries()) {
            const old = JSON.parse(/** @type {string} */ (await metadataDb.getCharacterCardJson(directories, avatar)));
            expect(storage.canonicalCardHash(cards[i])).toBe(storage.canonicalCardHash(old));
        }
        const { old, eng } = await bothPages({}, 'data_size', 'desc');
        expect(eng.ids).toEqual(old.ids);
    });

    test('lone surrogates are kept exactly, and a one-letter edit next to one is one edit', async () => {
        const card = { spec: 'chara_card_v2', spec_version: '2.0', name: 'a\ud800b', data: { name: 'a\ud800b', description: 'x\udc00y😀z', alternate_greetings: ['\ud83d'] } };
        await library.writeCard(directories, 'lone.png', JSON.stringify(card));
        card.data.description = 'x\udc00Y😀z';
        expect((await library.writeCard(directories, 'lone.png', JSON.stringify(card))).records).toBe(2);
        const [stored] = await library.cards(['lone.png']);
        expect(storage.canonicalJson(stored)).toBe(storage.canonicalJson(card));
    });

    test('a list item inserted between two with no room left places the list again', async () => {
        const avatar = 'crowded.png';
        const card = { spec: 'chara_card_v2', spec_version: '2.0', name: 'c', data: { name: 'c', alternate_greetings: ['a', 'b'] } };
        await library.writeCard(directories, avatar, JSON.stringify(card));
        for (let k = 0; k < 25; k++) {
            card.data.alternate_greetings.splice(1, 0, `m${k}`);
            await library.writeCard(directories, avatar, JSON.stringify(card));
        }
        const [stored] = await library.cards([avatar]);
        expect(/** @type {any} */ (stored).data.alternate_greetings).toEqual(card.data.alternate_greetings);
    });
});
