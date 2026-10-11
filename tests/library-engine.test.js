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
/** @type {typeof import('../public/scripts/hash-utils.js')} */
let hashUtils;
/** @type {typeof import('../src/character-card-normalize.js')} */
let storageNormalize;
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
    hashUtils = await import('../public/scripts/hash-utils.js');
    storageNormalize = await import('../src/character-card-normalize.js');
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
        extensions: { talkativeness: '0.5', world: r() < 0.4 ? 'lore' : r() < 0.15 ? 'a/b lore' : '', depth_prompt: { depth: 4, prompt: 'x' }, ...(r() < 0.3 ? { fav: false } : {}) },
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

/**
 * Writes `n` varied groups to both stores (the old store's file and row, the engine's group) with the same date
 * added, fav and tags.
 * @param {number} n
 * @param {number} seed
 */
async function writeGroupsBoth(n, seed) {
    const r = rng(seed);
    const groups = [];
    for (let i = 0; i < n; i++) {
        const id = String(1_700_000_000_000 + seed * 1000 + i);
        const group = {
            id,
            name: NAMES[Math.floor(r() * NAMES.length)],
            members: Array.from({ length: Math.floor(r() * 4) }, (_, k) => `m${k}-${i}.png`),
            avatar_url: r() < 0.5 ? '' : `g${i}.png`,
            allow_self_responses: r() < 0.5,
            activation_strategy: Math.floor(r() * 3),
            generation_mode: 0,
            disabled_members: r() < 0.3 ? ['x.png'] : [],
            fav: r() < 0.4,
            chat_id: id,
            chats: [id],
            auto_mode_delay: 5,
            generation_mode_join_prefix: '',
            generation_mode_join_suffix: r() < 0.3 ? '\n' : '',
            ...(r() < 0.3 ? { hideMutedSprites: true } : {}),
            ...(r() < 0.3 ? { someone_elses: { a: [1, 'x'] } } : {}),
        };
        fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
        await metadataDb.upsertGroupRow(directories, id, group.name, { fav: group.fav, group });
        const row = /** @type {any} */ (await metadataDb.queryEntities(directories, { ids: [id], groupsOnly: true })).rows[0];
        await library.writeGroup(group, { dateAdded: row.date_added });
        for (const t of TAG_IDS.filter(() => r() < 0.35)) {
            await metadataDb.assignEntityTag(directories, id, t);
            await library.assignTag(lib.TYPE.group, id, t, true);
        }
        groups.push(group);
    }
    return groups;
}

/**
 * A group object without the chat ids, which the sessions in its tree answer for.
 * @param {Record<string, any>} group
 */
function withoutChats(group) {
    const copy = { ...group };
    delete copy.chat_id;
    delete copy.chats;
    return copy;
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
        // Read with only the values a row is made from, the rows are the same, creator notes or not.
        for (const notes of [false, true]) {
            const narrow = await library.entities(ents.map(e => e?.id ?? null), lib.listRowValues(notes));
            expect(narrow.every(e => e?.hashes.length === 0)).toBe(true);
            expect(await library.listRows(/** @type {any[]} */ (narrow), notes)).toEqual(await library.listRows(/** @type {any[]} */ (ents), notes));
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

    test('groups read back and page as the old store has them, beside characters', async () => {
        await setUpTags();
        await writeBoth(library50(5));
        const groups = await writeGroupsBoth(12, 6);
        for (const filter of [...QUERIES, { groupsOnly: true }, { groupsOnly: true, fav: true, tags: { include: ['t-red'] } }]) {
            for (const [field, order] of SORTS) {
                const { old, eng } = await bothPages(filter, field, order);
                expect({ filter, field, order, ids: eng.ids }).toEqual({ filter, field, order, ids: old.ids });
                const exact = !old.approx && !eng.approx;
                expect(exact ? eng.total : null).toBe(exact ? old.total : null);
            }
        }
        // Rows and hash rows: the old store's hydrated rows, less the chat ids the sessions answer for.
        const params = { groupsOnly: true, sortField: 'name', limit: 100 };
        const oldRows = /** @type {any} */ (await metadataDb.queryEntities(directories, params)).rows;
        const engRows = (await library.query(params)).rows;
        expect(engRows.map(r => r.id)).toEqual(oldRows.map(r => r.id));
        const files = Object.fromEntries(groups.map(g => [g.id, JSON.parse(fs.readFileSync(path.join(directories.groups, `${g.id}.json`), 'utf8'))]));
        const oldTags = /** @type {Record<string, string[]>} */ (await metadataDb.getEntityTagIdsForMany(directories, groups.map(g => g.id), { type: 'group' }));
        for (const [i, row] of engRows.entries()) {
            const o = oldRows[i];
            const hydrated = { ...withoutChats(files[o.id]), fav: o.fav, date_added: o.date_added, date_last_chat: o.date_last_chat, chat_size: o.chat_size, tag_ids: [...oldTags[o.id]].sort() };
            expect(row.item).toEqual(hydrated);
        }
        const oldHashes = /** @type {any} */ (await metadataDb.queryEntities(directories, { ...params, wantRows: false, wantHashes: true })).hashRows;
        const engHashes = /** @type {any[]} */ ((await library.query({ ...params, wantRows: false, wantHashes: true })).hashRows);
        const batch = await library.groups(engHashes.map(h => h.id));
        for (const [i, h] of engHashes.entries()) {
            expect([h.favHash, h.tagIdsHash]).toEqual([oldHashes[i].favHash, oldHashes[i].tagIdsHash]);
            expect(h.contentHash).toBe(hashUtils.groupDigestContentHash(batch[i]) >>> 0);
        }
    });

    test('a character or group created with an unowned tree\'s key takes its id, and its messages', async () => {
        const [stem, gid] = [101n, 102n];
        library.nextId = 200n;
        await library.store.commit([
            { kind: 'entityCreate', entity: stem, type: lib.TYPE.tree, key: 'Old Friend', added: 1 },
            { kind: 'entityCreate', entity: gid, type: lib.TYPE.tree, key: '1700000000009', added: 1 },
            { kind: 'keyMap', user: 1n, key: Buffer.from('u') },
            { kind: 'messageAppend', id: 1n, owner: stem, time: 5, text: 'kept', flags: 0, user: 1n },
        ]);
        const { id } = await library.writeCard(directories, 'Old Friend.png', JSON.stringify({ name: 'Old Friend', data: { name: 'Old Friend' } }));
        expect(id).toBe(stem);
        const { id: g } = await library.writeGroup({ id: '1700000000009', name: 'G', members: [] });
        expect(g).toBe(gid);
        expect(await library.ids(lib.TYPE.tree, ['Old Friend', '1700000000009'])).toEqual([null, null]);
        const [entity] = await library.entities([stem]);
        expect([entity?.type, entity?.key]).toEqual([lib.TYPE.character, 'Old Friend.png']);
        expect((await library.query({ sortField: 'name', limit: 10 })).rows.map(r => r.id).sort()).toEqual(['1700000000009', 'Old Friend.png']);
        // Another new character gets a new id.
        expect((await library.writeCard(directories, 'New.png', JSON.stringify({ name: 'New' }))).id).toBe(200n);
    });

    test('a group\'s member changes write only the members that changed', async () => {
        const group = { id: '1700000000001', name: 'G', members: ['a.png', 'b.png', 'c.png'], disabled_members: [], avatar_url: '', allow_self_responses: false, chat_id: '1', chats: ['1'], unknown_key: { x: 1 } };
        await library.writeGroup(group);
        const steps = [
            [{ ...group, members: ['a.png', 'b.png', 'c.png'] }, 0],
            [{ ...group, members: ['d.png', 'a.png', 'b.png', 'c.png'] }, 2],
            [{ ...group, members: ['d.png', 'a.png', 'c.png'] }, 1],
            [{ ...group, members: ['d.png', 'a.png', 'c.png'], disabled_members: ['a.png'] }, 3],
            [{ ...group, members: ['d.png', 'a.png', 'c.png'], disabled_members: ['a.png'], name: 'G2' }, 1],
            [{ ...group, members: [], disabled_members: ['a.png'], name: 'G2', fav: true }, 5],
        ];
        for (const [next, records] of steps) {
            expect((await library.writeGroup(/** @type {any} */ (next))).records).toBe(records);
            const [stored] = await library.groups([group.id]);
            const want = withoutChats(/** @type {any} */ (next));
            expect(stored).toEqual({ ...want, fav: !!want.fav, tag_ids: [] });
        }
    });

    test('allow_global_styles, a date added and an avatar rename read as the old store\'s', async () => {
        await setUpTags();
        const entries = library50(6);
        await writeBoth(entries);
        const [a, b, c] = entries;
        await metadataDb.setCharacterAllowGlobalStyles(directories, a.avatar, true);
        expect(await library.setAllowGlobalStyles(a.avatar, true)).toBe(true);
        await metadataDb.setCharacterAllowGlobalStyles(directories, b.avatar, false);
        await library.setAllowGlobalStyles(b.avatar, false);
        const before = library.store.stats().logBytes;
        await library.setAllowGlobalStyles(b.avatar, false);
        expect(library.store.stats().logBytes).toBe(before);
        await metadataDb.setCharacterDateAdded(directories, c.avatar, 5);
        expect(await library.updateEntity(lib.TYPE.character, c.avatar, { dateAdded: 5 })).toBe(true);
        // A rename keeps the character: its fav, tags and date added go with it.
        const renamed = 'renamed-avatar.png';
        await metadataDb.upsertCharacterFromWrite(directories, renamed, JSON.stringify(a.card));
        await metadataDb.setCharacterAllowGlobalStyles(directories, renamed, true);
        await metadataDb.setCharacterFav(directories, renamed, a.fav);
        await metadataDb.renameCharacterRow(directories, a.avatar, renamed);
        expect(await library.updateEntity(lib.TYPE.character, a.avatar, { key: renamed })).toBe(true);
        expect(await library.updateEntity(lib.TYPE.character, b.avatar, { key: renamed })).toBe(false);
        const avatars = [renamed, ...entries.slice(1).map(e => e.avatar)];
        const old = await metadataDb.getShallowByIds(directories, avatars);
        const rows = await library.listRows(/** @type {any[]} */ (await library.entities(await library.ids(lib.TYPE.character, avatars))), false);
        for (const [i, avatar] of avatars.entries()) expect(rows[i]).toEqual(old[avatar]);
        expect(await library.ids(lib.TYPE.character, [a.avatar])).toEqual([null]);
        for (const [field, order] of [['name', 'asc'], ['date_added', 'desc'], ['fav', 'desc']]) {
            const { old: o, eng } = await bothPages({ tags: { include: ['t-red'] } }, field, order);
            expect(eng.ids).toEqual(o.ids);
            const all = await bothPages({}, field, order);
            expect(all.eng.ids).toEqual(all.old.ids);
        }
    });

    test('import dedup finds a card by each of its hashes as the old store does', async () => {
        const card = (/** @type {string} */ name) => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name, data: { name, description: name } });
        const hex = (/** @type {number} */ n) => n.toString(16).padStart(64, '0');
        const cards = [['x1.png', 'one', hex(1), hex(11)], ['x2.png', 'two', hex(2), hex(12)], ['x3.png', 'one', hex(3), hex(13)]];
        for (const [avatar, name, content, avatarIdentity] of cards) {
            await metadataDb.upsertCharacterFromWrite(directories, avatar, card(name), content, avatarIdentity);
            await library.writeCard(directories, avatar, card(name), { contentHash: content, avatarIdentityHash: avatarIdentity });
        }
        const identity = (/** @type {string} */ name) => storageNormalize.computeContentIdentityHash(JSON.parse(card(name)));
        const lookups = [
            [metadataDb.findCharacterIdByContentHash, (/** @type {string} */ h) => library.findByHash(lib.HASH.content, h), [hex(2), hex(9), null]],
            [metadataDb.findCharacterIdByContentIdentityHash, (/** @type {string} */ h) => library.findByHash(lib.HASH.identity, h), [identity('two'), identity('none'), null]],
            [metadataDb.findCharacterIdByAvatarIdentityHash, (/** @type {string} */ h) => library.findByHash(lib.HASH.avatarIdentity, h), [hex(13), hex(9), null]],
        ];
        for (const [oldFind, engFind, hashes] of lookups) {
            for (const h of /** @type {any[]} */ (hashes)) expect(await /** @type {any} */ (engFind)(h)).toBe(await /** @type {any} */ (oldFind)(directories, h));
        }
        for (const [cih, aih] of [[identity('one'), hex(13)], [identity('one'), hex(11)], [identity('two'), hex(13)], [identity('one'), null]]) {
            expect(await library.findByIdentityHashes(cih, aih)).toBe(await metadataDb.findCharacterIdByIdentityHashes(directories, cih, aih));
        }
    });

    test('hidden counts every entity of the kinds listed, less the page\'s rows', async () => {
        await setUpTags();
        await writeBoth(library50(7));
        await writeGroupsBoth(5, 7);
        for (const params of [{ includeGroups: true }, { includeGroups: false }, { groupsOnly: true }]) {
            const r = await library.query({ ...params, tags: { include: ['t-red'] }, limit: 7, wantHidden: true });
            const all = params.includeGroups === false
                ? await metadataDb.queryCharacters(directories, { wantRows: false, wantTotal: true })
                : await metadataDb.queryEntities(directories, { wantRows: false, wantTotal: true, groupsOnly: params.groupsOnly === true });
            expect({ hidden: r.hidden, approx: r.approxHidden }).toEqual({ hidden: Number(all?.total) - r.rows.length, approx: false });
        }
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
