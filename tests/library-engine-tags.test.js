import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { oldStoreOracle } from './util/old-store-oracle.js';

/**
 * Tags on the engine (src/library-engine.js, src/library-engine-tags.js) against the old store's answers for the
 * same writes. The old store is gone; its answers are recorded (tests/fixtures/old-store/library-engine-tags/,
 * see tests/util/old-store-oracle.js).
 */

/** @type {any} */
let metadataDb;
/** @type {Awaited<ReturnType<typeof oldStoreOracle>>} */
let oracle;
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
    oracle = await oldStoreOracle('library-engine-tags', 'character-metadata-db.js', () => directories);
    metadataDb = oracle.store;
    lib = await import('../src/library-engine.js');
    engine = (await import('../engine/load.js')).loadEngine().binding;
});

beforeEach(async () => {
    oracle.begin(String(expect.getState().currentTestName));
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
    oracle.end();
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

// Case, accents and ties; no lone surrogates (the old store's SQLite text turns them into U+FFFD).
const TAG_NAMES = ['Alpha', 'alpha', 'Álpha', 'beta', 'Beta', 'Ölaf', 'olaf', 'zed', '', 'a b', '😀 smile', 'Σίσυφος', 'ab', 'a'];
const FOLDER_TYPES = [undefined, 'NONE', 'OPEN', 'CLOSED', { odd: 1 }];
const ORDERS = [undefined, 1, 2, 2, null, '3', 'x', -5, 1.5];

/** The old store's /by-ids answer, as the route builds it. */
async function oldByIds(ids) {
    const merged = /** @type {Record<string, string>} */ (await metadataDb.getMergedTagTargets(directories, ids));
    const asked = new Set(ids.map(String));
    const targets = [...new Set(Object.values(merged))].filter(id => !asked.has(id));
    const tags = await metadataDb.getTagDefinitionsByIds(directories, [...ids, ...targets]);
    const goneOrMerged = /** @type {string[]} */ (await metadataDb.getGoneTagIds(directories, ids));
    return { tags, gone: goneOrMerged.filter(id => !Object.hasOwn(merged, id)), merged };
}

/** Both stores' answers to the same calls. */
const both = {
    create: async (/** @type {any} */ tag, /** @type {any} */ options) => [await metadataDb.createTagDefinition(directories, structuredClone(tag), options), await library.tags.create(structuredClone(tag), options)],
    edit: async (/** @type {string} */ id, /** @type {any} */ patch) => [await metadataDb.editTagDefinition(directories, id, patch), await library.tags.edit(id, patch)],
    delete: async (/** @type {string} */ id, /** @type {string | null} */ into) => [await metadataDb.deleteTagDefinition(directories, id, into), await library.tags.delete(id, into)],
    assign: async (/** @type {string} */ key, /** @type {string} */ tag) => [await metadataDb.assignEntityTagReporting(directories, key, tag), await library.tags.assign(key, tag)],
    unassign: async (/** @type {string} */ key, /** @type {string} */ tag) => [await metadataDb.unassignEntityTag(directories, key, tag), await library.tags.unassign(key, tag)],
    copy: async (/** @type {string} */ from, /** @type {string} */ to) => [await metadataDb.copyEntityTags(directories, from, to), await library.tags.copy(from, to)],
    move: async (/** @type {string} */ from, /** @type {string} */ to) => [await metadataDb.moveEntityTags(directories, from, to), await library.tags.move(from, to)],
};

/** Waits until no merged tag's carriers are still moving on the engine. */
async function settle() {
    const ids = [];
    let after;
    for (;;) {
        const page = await library.store.tagPage({ sort: 0, limit: 500, ...(after ? { after } : {}) });
        ids.push(...page.ids);
        if (!page.cursor) break;
        after = page.cursor;
    }
    for (let i = 0; i < 400; i++) {
        const counts = await library.store.tagCounts(ids);
        if (!counts.some((/** @type {any} */ c) => c.approximate)) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('a merge never finished');
}

/** Characters and groups in both stores, with no tags. */
async function setUpEntities(r, characters = 16, groups = 5) {
    const keys = [];
    for (let i = 0; i < characters; i++) {
        const avatar = `c${i}.png`;
        const json = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: `c${i}`, data: { name: `c${i}`, description: 'd' } });
        await metadataDb.upsertCharacterFromWrite(directories, avatar, json);
        await library.writeCard(directories, avatar, json);
        keys.push(avatar);
    }
    for (let i = 0; i < groups; i++) {
        const id = String(1_700_000_000_000 + i);
        const group = { id, name: `g${i}`, members: ['c0.png'], avatar_url: '', allow_self_responses: false, chat_id: id, chats: [id], fav: r() < 0.5 };
        fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
        await metadataDb.upsertGroupRow(directories, id, group.name, { fav: group.fav, group });
        await library.writeGroup(group);
        keys.push(id);
    }
    return keys;
}

/** A varied tag. */
function makeTag(r, i) {
    const pick = (/** @type {any[]} */ list) => list[Math.floor(r() * list.length)];
    /** @type {Record<string, unknown>} */
    const tag = { id: `tag-${String(i).padStart(3, '0')}`, name: pick(TAG_NAMES) };
    const folder = pick(FOLDER_TYPES);
    if (folder !== undefined) tag.folder_type = folder;
    const order = pick(ORDERS);
    if (order !== undefined || r() < 0.2) tag.sort_order = order ?? null;
    if (r() < 0.4) tag.color = pick(['', '#fff', 'red']);
    if (r() < 0.2) tag.create_date = 1_700_000_000_000 + i;
    return tag;
}

/** Every page of a query through cursors of `pageSize`, both stores. */
async function bothQueryPages(params, pageSize = 3) {
    const read = async (/** @type {(p: any) => Promise<any>} */ query) => {
        const ids = [];
        /** @type {Record<string, number>} */
        const counts = {};
        const approximate = [];
        let cursor = null;
        for (let page = 0; page < 200; page++) {
            const r = await query({ ...params, pageSize, cursor, counts: true });
            if (r === 'invalid-cursor' || r === null) throw new Error(String(r));
            ids.push(...r.rows.map((/** @type {any} */ row) => row.id));
            Object.assign(counts, r.counts);
            approximate.push(...r.approximate);
            if (!r.cursor) break;
            cursor = r.cursor;
        }
        return { ids, counts, approximate };
    };
    const old = await read(p => metadataDb.queryTags(directories, { ...p, after: p.cursor ? metadataDb.decodeTagQueryCursor(p.cursor, p.sort) : null }));
    const eng = await read(p => library.tags.query(p));
    return { old, eng };
}

const FILTERS = [
    {},
    { used: true },
    { folders: true },
    { folders: true, folderType: 'OPEN' },
    { folders: true, folderType: 'CLOSED', used: true },
    { search: 'a' },
    { search: 'Á' },
    { name: 'alpha' },
    { name: '' },
    { contains: 'l' },
    { contains: 'ß' },
    { used: true, search: 'b' },
];

/** Compares every read the tag manager makes, both stores; the whole list holds more than `minimum` tags. */
async function compareReads(keys, tagIds, minimum = 20) {
    for (const sort of ['manual', 'alphabetical', 'by_entries']) {
        for (const filter of FILTERS) {
            for (const pageSize of [3, 50]) {
                const { old, eng } = await bothQueryPages({ sort, ...filter }, pageSize);
                expect({ sort, filter, ids: eng.ids }).toEqual({ sort, filter, ids: old.ids });
                if (Object.keys(filter).length === 0) expect(eng.ids.length).toBeGreaterThan(minimum);
                expect(eng.counts).toEqual(old.counts);
                expect(eng.approximate).toEqual(old.approximate);
            }
            const ids = [...tagIds, 'nobody'];
            const old = await metadataDb.queryTags(directories, { sort, ...filter, ids, pageSize: 500 });
            const eng = await library.tags.query({ sort, ...filter, ids, pageSize: 500 });
            expect({ sort, filter, ids: /** @type {any} */ (eng).rows }).toEqual({ sort, filter, ids: /** @type {any} */ (old).rows });
        }
    }
    expect(await library.tags.tagIdsFor([...keys, 'nobody.png', 'nogroup', ''])).toEqual(await metadataDb.getEntityTagIdsForMany(directories, [...keys, 'nobody.png', 'nogroup', '']));
    expect(await library.tags.countUnused()).toBe(await metadataDb.countUnusedTags(directories));
    const names = [...TAG_NAMES, 'ALPHA', 'ölaf', 'nothing'];
    const byName = (/** @type {any[]} */ found) => found.map(f => [f.name, f.tag?.id ?? null]);
    expect(byName(await library.tags.findByNames(names))).toEqual(byName(/** @type {any[]} */ (await metadataDb.findTagsByNames(directories, names))));
    const sortById = (/** @type {any[]} */ tags) => [...tags].sort((a, b) => (a.id < b.id ? -1 : 1));
    const engDefs = [];
    for await (const batch of library.tags.backupDefinitions()) engDefs.push(...batch);
    const oldDefs = [];
    for await (const batch of /** @type {any} */ (await metadataDb.streamTagDefinitionBatches(directories))) oldDefs.push(...batch);
    expect(sortById(engDefs)).toEqual(sortById(oldDefs));
    const tagMap = async (/** @type {AsyncIterable<any[]>} */ stream) => {
        /** @type {Record<string, string[]>} */
        const map = {};
        for await (const batch of stream) for (const { key, tagIds } of batch) map[key] = [...new Set([...(map[key] ?? []), ...tagIds])].sort();
        return map;
    };
    expect(await tagMap(library.tags.backupAssignments())).toEqual(await tagMap(/** @type {any} */ (await metadataDb.streamEntityTagAssignmentBatches(directories))));
}

describe('tags on the engine against the old store', () => {
    test.each([7, 8, 9])('definitions, assignments, merges and prunes read back as the old store\'s (seed %i)', async (seed) => {
        const r = rng(seed);
        const keys = await setUpEntities(r);
        const entityEnds = [await metadataDb.getEntityTagChangesEnd(directories), await library.tags.entityChangesEnd()];
        const tagIds = [];
        for (let i = 0; i < 40; i++) {
            const tag = makeTag(r, i);
            const [o, e] = await both.create(tag, { freeName: r() < 0.1 && tag.name !== '' });
            expect(e).toEqual(o);
            tagIds.push(tag.id);
        }
        expect((await both.create({ id: tagIds[0], name: 'again' }))).toEqual([{ refused: [{ id: tagIds[0], reason: 'exists' }] }, { refused: [{ id: tagIds[0], reason: 'exists' }] }]);
        for (const key of keys) {
            for (const tag of tagIds.filter(() => r() < 0.07)) {
                const [o, e] = await both.assign(key, tag);
                expect(e).toEqual(o);
            }
        }
        // A key no definition has is assigned all the same, and listed nowhere until one is written.
        expect(await both.assign(keys[0], 'nodef-1')).toEqual([{ result: 'ok', assigned: 'nodef-1', reason: null, defined: false }, { result: 'ok', assigned: 'nodef-1', reason: null, defined: false }]);
        await both.assign(keys[1], 'nodef-2');
        expect((await both.assign('nobody.png', tagIds[0]))[1]).toEqual({ result: 'not_found', assigned: null, reason: null, defined: false });
        for (const id of tagIds.filter(() => r() < 0.3)) {
            const patch = r() < 0.5 ? { name: TAG_NAMES[Math.floor(r() * TAG_NAMES.length)] } : r() < 0.5 ? { folder_type: 'OPEN', sort_order: 7 } : { color: 'blue' };
            const [o, e] = await both.edit(id, patch);
            expect(e).toEqual(o);
        }
        expect(await both.edit('nobody', { name: 'x' })).toEqual([{ refused: [{ id: 'nobody', reason: 'missing' }] }, { refused: [{ id: 'nobody', reason: 'missing' }] }]);
        await both.unassign(keys[2], tagIds[3]);
        await both.unassign(keys[2], 'nobody');
        expect(await both.copy(keys[3], keys[4])).toEqual(['ok', 'ok']);
        expect(await both.copy('nobody.png', keys[4])).toEqual(['not_found', 'not_found']);
        const [movedOld, movedEng] = await both.move(keys[5], keys[6]);
        expect({ ...movedEng, moved: [...movedEng.moved].sort() }).toEqual({ ...movedOld, moved: [...movedOld.moved].sort() });

        // Merges, one into a tag merged in turn, and a delete with no merge.
        const [x, y, z, w] = tagIds.slice(10, 14);
        const deletes = [[x, y], [y, z], [w, null], [x, z], [z, z], [tagIds[15], w]];
        for (const [id, into] of deletes) {
            const [o, e] = await both.delete(id, into);
            expect(e).toEqual(o);
        }
        expect((await both.assign(keys[7], x))[1]).toEqual({ result: 'ok', assigned: z, reason: 'merged', defined: true });
        expect((await both.assign(keys[7], w))[1]).toEqual({ result: 'ok', assigned: null, reason: 'deleted', defined: false });
        // The old store forgets a merge once it finishes it; the engine keeps it, so this is read first.
        const asked = [x, y, w, z, tagIds[0], 'nodef-1', 'nobody'];
        const [ob, eb] = [await oldByIds(asked), await library.tags.byIds(asked)];
        const sortTags = (/** @type {any} */ a) => ({ ...a, tags: [...a.tags].sort((p, q) => (p.id < q.id ? -1 : 1)), gone: [...a.gone].sort() });
        expect(sortTags(eb)).toEqual(sortTags(ob));
        await metadataDb.finishDeletedTags(directories);
        await settle();
        await compareReads(keys, tagIds);

        // The definition of a key only assignments named.
        await both.create({ id: 'nodef-1', name: 'Defined later' });
        await compareReads(keys, [...tagIds, 'nodef-1']);

        // Prunes, every unused tag.
        const unused = await library.tags.countUnused();
        const [prunedOld, prunedEng] = [await metadataDb.pruneUnusedTags(directories, 500), await library.tags.prune(500)];
        expect([...prunedEng].sort()).toEqual([.../** @type {string[]} */ (prunedOld)].sort());
        expect(prunedEng.length).toBe(unused);
        await compareReads(keys, tagIds);

        // Change feeds, as sets of ids.
        const feedIds = async (/** @type {(since: number) => Promise<any>} */ read) => {
            const ids = new Set();
            let since = 0;
            for (;;) {
                const page = await read(since);
                expect(page.reset).toBe(false);
                for (const t of page.tags) ids.add(t.id);
                for (const t of page.removed) ids.add(t.id);
                if (!page.hasMore) return [...ids].sort();
                since = page.seq;
            }
        };
        expect(await feedIds(since => library.tags.changes(since, { limit: 7 }))).toEqual(await feedIds(since => metadataDb.getTagChangesSince(directories, since, { limit: 7 })));
        const entityIds = async (/** @type {(c: any) => Promise<any>} */ read, /** @type {any} */ start) => {
            const ids = new Set();
            let cursors = { sinceSeq: start.seq, sinceGroupsVersion: start.groupsVersion };
            for (;;) {
                const page = await read(cursors);
                expect(page.reset).toBe(false);
                for (const id of page.ids) ids.add(id);
                if (!page.hasMore) return [...ids].sort();
                cursors = { sinceSeq: page.seq, sinceGroupsVersion: page.groupsVersion };
            }
        };
        expect(await entityIds(c => library.tags.entityChanges(c, { limit: 4 }), entityEnds[1])).toEqual(await entityIds(c => metadataDb.getEntityTagChangesSince(directories, c, { limit: 4 }), entityEnds[0]));
        expect((await library.tags.changes('x', { limit: 5 })).reset).toBe(true);
        expect((await library.tags.changes(Number.MAX_SAFE_INTEGER, { limit: 5 })).reset).toBe(true);
    });
});

/** Every manual page, through cursors of `pageSize`, as ids. */
async function manualPages(query, filter = {}, pageSize = 3) {
    const ids = [];
    let cursor = null;
    for (let page = 0; page < 500; page++) {
        const r = await query({ sort: 'manual', ...filter, pageSize, cursor });
        if (r === 'invalid-cursor' || r === null) throw new Error(String(r));
        ids.push(...r.rows.map((/** @type {any} */ row) => row.id));
        if (!r.cursor) return ids;
        cursor = r.cursor;
    }
    throw new Error('a manual walk never ended');
}

const oldManual = (/** @type {any} */ filter, /** @type {number} */ pageSize) => manualPages(p => metadataDb.queryTags(directories, { ...p, after: p.cursor ? metadataDb.decodeTagQueryCursor(p.cursor, 'manual') : null }), filter, pageSize);
const engManual = (/** @type {any} */ filter, /** @type {number} */ pageSize) => manualPages(p => library.tags.query(p), filter, pageSize);

/** Both stores' manual order, every way it is read. */
async function compareManual() {
    for (const filter of [{}, { used: true }, { search: 'a' }, { folders: true }]) {
        for (const pageSize of [2, 50]) {
            const old = await oldManual(filter, pageSize);
            expect({ filter, pageSize, ids: await engManual(filter, pageSize) }).toEqual({ filter, pageSize, ids: old });
        }
    }
    const ids = ['m00', 'm03', 'm07', 'm11', 'm15', 'm20', 'nobody'];
    const old = /** @type {any} */ (await metadataDb.queryTags(directories, { sort: 'manual', ids, pageSize: 50 })).rows.map((/** @type {any} */ t) => t.id);
    const eng = /** @type {any} */ (await library.tags.query({ sort: 'manual', ids, pageSize: 50 })).rows.map((/** @type {any} */ t) => t.id);
    expect(eng).toEqual(old);
}

/** Every tag's stored sort_order, both stores. */
async function compareOrders(ids) {
    const sorted = (/** @type {any[]} */ tags) => Object.fromEntries(tags.map(t => [t.id, t.sort_order]));
    const old = sorted(/** @type {any[]} */ (await metadataDb.getTagDefinitionsByIds(directories, ids)));
    const eng = sorted((await library.tags.byIds(ids)).tags);
    expect(eng).toEqual(old);
}

/** Tags with orders, ties, none and a few odd values, a few carried, in both stores. */
async function setUpOrderedTags(r, n = 24) {
    const keys = await setUpEntities(r, 6, 0);
    const orders = [1, 2, 3, 3, 3, 4, 5, undefined, undefined, 'x', 7.5, 7.5, null, 10, 11, undefined, 12, 13, 13, 14, undefined, 20, 21, 22];
    const ids = [];
    for (let i = 0; i < n; i++) {
        const id = `m${String(i).padStart(2, '0')}`;
        /** @type {Record<string, unknown>} */
        const tag = { id, name: TAG_NAMES[i % TAG_NAMES.length] || `n${i}` };
        if (orders[i] !== undefined) tag.sort_order = orders[i];
        if (i % 5 === 0) tag.folder_type = 'OPEN';
        await both.create(tag);
        ids.push(id);
    }
    for (const [k, key] of keys.entries()) for (const id of ids.filter((_, i) => i % (k + 2) === 0)) await both.assign(key, id);
    return ids;
}

describe('moves and reorders against the old store', () => {
    test.each([11, 12])('moves write what the old store writes, and the order reads back as its (seed %i)', async (seed) => {
        const r = rng(seed);
        const ids = await setUpOrderedTags(r);
        await compareManual();
        const placements = [];
        for (let k = 0; k < 40; k++) {
            const id = ids[Math.floor(r() * ids.length)];
            const anchor = r() < 0.05 ? id : r() < 0.05 ? 'nobody' : ids[Math.floor(r() * ids.length)];
            placements.push([id, r() < 0.5 ? { before: anchor } : { after: anchor }]);
        }
        // Moves to one place again and again run out of room between neighbours, so windows are spread.
        for (let k = 0; k < 60; k++) placements.push([ids[k % 3], { after: ids[3] }], [ids[4 + (k % 3)], { before: ids[7] }]);
        for (const [id, placement] of placements) {
            const old = /** @type {any} */ (await metadataDb.moveTagDefinition(directories, id, placement));
            const eng = await library.tags.moveDefinition(id, placement);
            const byId = (/** @type {any[]} */ w) => [...w].sort((a, b) => (a.id < b.id ? -1 : 1));
            expect({ id, placement, refused: eng.refused, written: byId(eng.written) }).toEqual({ id, placement, refused: old.refused, written: byId(old.written) });
        }
        await compareManual();
        await compareOrders(ids);
    });

    test('a tie, a spent gap and an anchor with no order are handled as the old store handles them', async () => {
        const tags = [['a', 1], ['b', 1], ['c', 1], ['d', 'no'], ['e', 'no'], ['f', 'no'], ['g', 'x'], ['h', 5], ['i', 6]];
        for (const [id, order] of tags) await both.create({ id, name: `name ${id}`, ...(order === undefined ? {} : { sort_order: order }) });
        let spread = 0;
        const move = async (/** @type {string} */ id, /** @type {any} */ placement) => {
            const old = /** @type {any} */ (await metadataDb.moveTagDefinition(directories, id, placement));
            const eng = await library.tags.moveDefinition(id, placement);
            const byId = (/** @type {any[]} */ w) => [...w].sort((x, y) => (x.id < y.id ? -1 : 1));
            expect({ id, placement, refused: eng.refused, written: byId(eng.written) }).toEqual({ id, placement, refused: old.refused, written: byId(old.written) });
            if (eng.written.length > 1) spread++;
            return eng;
        };
        // Next to a tie: no room between the neighbours, so a window is spread.
        expect((await move('h', { after: 'a' })).written.length).toBeGreaterThan(1);
        // Already in place among the tags with no order.
        expect((await move('d', { before: 'e' })).written).toEqual([]);
        // An anchor with no order: the tags with none before it are numbered first.
        expect((await move('f', { before: 'e' })).written.length).toBeGreaterThan(2);
        // Two tags taking turns right after one anchor halve the gap until it is spent.
        for (let k = 0; k < 70; k++) await move(k % 2 ? 'b' : 'c', { after: 'i' });
        expect(spread).toBeGreaterThan(2);
        await move('g', { before: 'a' });
        await compareManual();
        await compareOrders(tags.map(([id]) => /** @type {string} */ (id)));
    });

    test.each(['alphabetical', 'by_entries'])('a reorder in %s mode, with moves, values and creates queued behind it, reads and ends as the old store\'s', async (mode) => {
        const r = rng(mode.length);
        const ids = await setUpOrderedTags(r);
        library.tags.passBatch = 5;
        const [o1, e1] = [await metadataDb.reorderTagDefinitions(directories, ids[3], { after: ids[9] }, mode), await library.tags.reorderDefinitions(ids[3], { after: ids[9] }, mode)];
        expect(e1).toEqual(o1);
        await compareManual();
        const queued = [
            () => both.edit(ids[1], { sort_order: 2.5 }),
            async () => [await metadataDb.moveTagDefinition(directories, ids[5], { before: ids[3] }), await library.tags.moveDefinition(ids[5], { before: ids[3] })],
            async () => [await metadataDb.moveTagDefinition(directories, ids[12], { after: ids[5] }), await library.tags.moveDefinition(ids[12], { after: ids[5] })],
            () => both.create({ id: 'late', name: 'Late', sort_order: 0.5 }),
            () => both.create({ id: 'later', name: 'aaa later' }),
            async () => [await metadataDb.moveTagDefinition(directories, ids[3], { after: ids[3] }), await library.tags.moveDefinition(ids[3], { after: ids[3] })],
            () => both.edit(ids[7], { sort_order: 'x' }),
            async () => [await metadataDb.moveTagDefinition(directories, ids[20], { before: ids[1] }), await library.tags.moveDefinition(ids[20], { before: ids[1] })],
            async () => [await metadataDb.moveTagDefinition(directories, ids[2], { before: 'later' }), await library.tags.moveDefinition(ids[2], { before: 'later' })],
        ];
        for (const step of queued) {
            const [o, e] = await step();
            expect(e).toEqual(o);
            await compareManual();
        }
        await metadataDb.runTagReorderPassIfNeeded(directories);
        await library.tags.startPass();
        expect((await library.store.tagPass()).mode).toBeUndefined();
        expect((await library.tags.queue()).length).toBe(0);
        await compareManual();
        await compareOrders([...ids, 'late', 'later']);
    });
});

describe('the reorder pass on the engine', () => {
    /** The stored manual order: the tags with an order by it, then the rest by name. */
    const storedManual = async () => {
        const ids = [];
        let after;
        for (;;) {
            const page = await library.store.tagPage({ sort: 2, limit: 100, ...(after ? { after } : {}) });
            ids.push(...page.ids);
            if (!page.cursor) break;
            after = page.cursor;
        }
        return library.tags.tagKeys(ids);
    };

    test('while it drains, a manual read shows where the queued moves will leave the tags', async () => {
        const ids = await setUpOrderedTags(rng(5));
        library.tags.passBatch = 4;
        await library.tags.reorderDefinitions(ids[2], { before: ids[15] }, 'alphabetical');
        while ((await library.store.tagPass()).phase !== 2) await library.tags.lane(() => library.tags.passStep());
        await library.tags.moveDefinition(ids[8], { after: ids[2] });
        await library.tags.edit(ids[9], { sort_order: -3 });
        await library.tags.moveDefinition(ids[11], { before: ids[9] });
        await library.tags.moveDefinition(ids[12], { after: ids[11] });
        await library.tags.edit(ids[13], { sort_order: 'no order' });
        await library.tags.moveDefinition(ids[14], { before: ids[13] });
        const shown = await engManual({}, 3);
        const cursorBefore = /** @type {any} */ (await library.tags.query({ sort: 'manual', pageSize: 2 })).cursor;
        await library.tags.startPass();
        expect(await storedManual()).toEqual(shown);
        // A cursor made while it drained names the stored order, so it still reads on.
        expect(await library.tags.query({ sort: 'manual', pageSize: 2, cursor: cursorBefore })).not.toBe('invalid-cursor');
    });

    test('a cursor is good only in the order it was made in', async () => {
        const ids = await setUpOrderedTags(rng(6));
        const stored = /** @type {any} */ (await library.tags.query({ sort: 'manual', pageSize: 2 })).cursor;
        const oldStored = /** @type {any} */ (await metadataDb.queryTags(directories, { sort: 'manual', pageSize: 2 })).cursor;
        await metadataDb.reorderTagDefinitions(directories, ids[1], { after: ids[2] }, 'alphabetical');
        await library.tags.reorderDefinitions(ids[1], { after: ids[2] }, 'alphabetical');
        expect(await library.tags.query({ sort: 'manual', pageSize: 2, cursor: stored })).toBe('invalid-cursor');
        expect(await metadataDb.queryTags(directories, { sort: 'manual', pageSize: 2, after: metadataDb.decodeTagQueryCursor(oldStored, 'manual') })).toBe('invalid-cursor');
        const underPass = /** @type {any} */ (await library.tags.query({ sort: 'manual', pageSize: 2 })).cursor;
        expect(await library.tags.query({ sort: 'manual', pageSize: 2, cursor: underPass })).not.toBe('invalid-cursor');
        await library.tags.reorderDefinitions(ids[1], { after: ids[3] }, 'by_entries');
        expect(await library.tags.query({ sort: 'manual', pageSize: 2, cursor: underPass })).toBe('invalid-cursor');
        await library.tags.startPass();
        expect(await library.tags.query({ sort: 'manual', pageSize: 2, cursor: underPass })).toBe('invalid-cursor');
    });

    test('tags whose counts move behind the walk, and tags made meanwhile, get orders after the rest', async () => {
        const ids = await setUpOrderedTags(rng(8));
        library.tags.passBatch = 3;
        await library.tags.reorderDefinitions(ids[0], { after: ids[1] }, 'by_entries');
        await library.tags.lane(() => library.tags.passStep());
        await library.tags.lane(() => library.tags.passStep());
        // Tags the walk hasn't reached yet move ahead of it: it passes them by.
        const unwalked = (await library.store.tagPage({ sort: 1, unstamped: (await library.store.tagPass()).pass, limit: 100 })).ids;
        const behind = (await library.tags.tagKeys(unwalked.slice(-3))).map(String);
        for (const key of ['c0.png', 'c1.png', 'c2.png', 'c3.png', 'c4.png', 'c5.png']) for (const tag of behind) await library.tags.assign(key, tag);
        await library.tags.create({ id: 'made-meanwhile', name: 'made meanwhile' });
        while ((await library.store.tagPass()).phase === 0) await library.tags.lane(() => library.tags.passStep());
        const walked = await library.store.tagPass();
        expect(walked.live - walked.stamped).toBe(behind.length);
        await library.tags.startPass();
        const order = await storedManual();
        const live = (await library.store.tagPass()).live;
        expect(order.length).toBe(live);
        // Every tag got an order from the pass: none is left with an older one, and none shares one.
        const defs = (await library.tags.byIds(/** @type {string[]} */ (order))).tags;
        const values = defs.map(t => t.sort_order);
        expect(new Set(values).size).toBe(values.length);
        expect(values.every(v => typeof v === 'number')).toBe(true);
        const byKey = Object.fromEntries(defs.map(t => [t.id, t.sort_order]));
        for (const key of [...behind, 'made-meanwhile']) expect(byKey[key]).toBeGreaterThanOrEqual(live - 4);
    });

    test('a queued move whose anchor was deleted leaves its tag where the pass put it, and says so', async () => {
        const ids = await setUpOrderedTags(rng(10));
        for (const [o, e] of [
            [await metadataDb.reorderTagDefinitions(directories, ids[1], { after: ids[2] }, 'alphabetical'), await library.tags.reorderDefinitions(ids[1], { after: ids[2] }, 'alphabetical')],
            [await metadataDb.moveTagDefinition(directories, ids[3], { before: ids[6] }), await library.tags.moveDefinition(ids[3], { before: ids[6] })],
            [await metadataDb.moveTagDefinition(directories, ids[4], { after: ids[10] }), await library.tags.moveDefinition(ids[4], { after: ids[10] })],
            await both.delete(ids[6], null),
            await both.delete(ids[4], null),
        ]) expect(e).toEqual(o);
        await metadataDb.finishDeletedTags(directories);
        /** @type {any[]} */
        const failed = [];
        library.tags.on('tag-move-failed', payload => failed.push(payload));
        /** @type {any[]} */
        const oldFailed = [];
        const onOld = (/** @type {string} */ _root, /** @type {any} */ payload) => oldFailed.push(payload);
        metadataDb.characterChangeEmitter.on(metadataDb.TAG_MOVE_FAILED_EVENT, onOld);
        try {
            await metadataDb.runTagReorderPassIfNeeded(directories);
        } finally {
            metadataDb.characterChangeEmitter.off(metadataDb.TAG_MOVE_FAILED_EVENT, onOld);
        }
        await library.tags.startPass();
        expect(failed).toEqual(oldFailed);
        expect(failed.map(f => [f.tagId, f.anchorId, f.reason])).toEqual([[ids[3], ids[6], 'deleted']]);
        await compareManual();
        await compareOrders(ids.filter((_, i) => i !== 4 && i !== 6));
    });

    test('a pass a stop left recorded resumes from its place when started again', async () => {
        const ids = await setUpOrderedTags(rng(9));
        await metadataDb.reorderTagDefinitions(directories, ids[4], { before: ids[0] }, 'alphabetical');
        await metadataDb.runTagReorderPassIfNeeded(directories);
        library.tags.passBatch = 4;
        await library.tags.reorderDefinitions(ids[4], { before: ids[0] }, 'alphabetical');
        await library.tags.lane(() => library.tags.passStep());
        await library.tags.lane(() => library.tags.passStep());
        await library.close();
        library = await lib.LibraryEngine.open(engine, path.join(directories.root, 'store'));
        expect((await library.store.tagPass()).n).toBe(8);
        await library.tags.startPass();
        await compareManual();
        await compareOrders(ids);
    });
});

describe('restore and the settings import against the old store', () => {
    /** @type {any} */
    let cryptoModule;
    let uuids = 0;
    beforeAll(async () => {
        cryptoModule = (await import('node:crypto')).default;
    });
    /** Runs `old` then `eng`, each with uuids handed out from the same start. */
    async function sameUuids(/** @type {() => Promise<any>} */ old, /** @type {() => Promise<any>} */ eng) {
        const spy = jest.spyOn(cryptoModule, 'randomUUID');
        try {
            uuids = 0;
            spy.mockImplementation(() => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}`);
            const o = await old();
            uuids = 0;
            const e = await eng();
            return [o, e];
        } finally {
            spy.mockRestore();
        }
    }

    /**
     * Tags, assignments and a merged and a deleted tag, in both stores. The old store forgets a deletion once it
     * finishes it, so it finishes after what is compared.
     */
    async function setUp() {
        const keys = await setUpEntities(rng(21), 6, 2);
        for (const tag of [
            { id: 'keep', name: 'Keep', color: 'red', sort_order: 3 },
            { id: 'named', name: 'Same Name', sort_order: 4 },
            { id: 'other', name: 'Other', sort_order: 5 },
            // Below the live tags' orders: the old store counts a deleted tag's order until it finishes it.
            { id: 'merged', name: 'Merged', sort_order: 0.5 },
            { id: 'dropped', name: 'Dropped', sort_order: 0.75 },
            { id: 'odd', name: 'Odd', sort_order: 'x' },
        ]) await both.create(tag);
        await both.assign(keys[0], 'keep');
        await both.assign(keys[1], 'merged');
        await both.delete('merged', 'keep');
        await both.delete('dropped', null);
        return keys;
    }

    async function finish() {
        await metadataDb.finishDeletedTags(directories);
        await settle();
    }

    const backup = (/** @type {string[]} */ keys) => ({
        tags: [
            { id: 'keep', name: 'Keep', color: 'blue', sort_order: 30 },
            { id: 'renamed', name: 'same name', color: 'green' },
            { id: 'other', name: 'Keep' },
            { id: 'merged', name: 'Merged again' },
            { id: 'brand-new', name: 'Brand New' },
            { id: 'alpha-new', name: 'alpha new' },
            { id: 'ordered-new', name: 'Ordered', sort_order: 1.5 },
            { id: 'odd', name: 'Odd', sort_order: 'still x', folder_type: 'OPEN' },
            { id: '', name: 'no id' },
            { id: 'no-name' },
            'not a tag',
            { id: 'brand-new', name: 'Brand New twice' },
        ],
        tagMap: {
            [keys[0]]: ['keep', 'renamed', 'merged', 'dropped', 'ghost', 7, ''],
            [keys[2]]: ['brand-new', 'alpha-new'],
            [keys[7]]: ['ordered-new'],
            'nobody.png': ['keep'],
            [keys[3]]: 'not a list',
        },
    });

    const sorted = (/** @type {any} */ result) => ({
        ...result,
        undefinedTagIds: [...result.undefinedTagIds].sort((a, b) => (a.key < b.key ? -1 : 1)),
    });

    test.each([true, false])('a restore (overwrite %s) restores what the old store restores and reads back as its', async (overwrite) => {
        const keys = await setUp();
        const { tags, tagMap } = backup(keys);
        const [old, eng] = await sameUuids(
            () => metadataDb.restoreTagBackup(directories, { tags: structuredClone(tags), tagMap, overwrite }),
            () => library.tags.restore({ tags: structuredClone(tags), tagMap, overwrite }),
        );
        expect(sorted(eng)).toEqual(sorted(old));
        await finish();
        const ids = ['keep', 'renamed', 'other', 'named', 'brand-new', 'alpha-new', 'ordered-new', 'odd', '00000000-0000-4000-8000-000000000001'];
        await compareReads(keys, ids, 6);
        await compareManual();
        await compareOrders(ids);
    });

    test('a restore while moves queue queues its orders behind them', async () => {
        const keys = await setUp();
        await metadataDb.reorderTagDefinitions(directories, 'keep', { after: 'other' }, 'alphabetical');
        await library.tags.reorderDefinitions('keep', { after: 'other' }, 'alphabetical');
        const { tags, tagMap } = backup(keys);
        const [old, eng] = await sameUuids(
            () => metadataDb.restoreTagBackup(directories, { tags: structuredClone(tags), tagMap, overwrite: true }),
            () => library.tags.restore({ tags: structuredClone(tags), tagMap, overwrite: true }),
        );
        expect(sorted(eng)).toEqual(sorted(old));
        await finish();
        await compareManual();
        await metadataDb.runTagReorderPassIfNeeded(directories);
        await library.tags.startPass();
        await compareManual();
        await compareOrders(['keep', 'renamed', 'other', 'named', 'brand-new', 'alpha-new', 'ordered-new', 'odd']);
    });

    test('settings\' tags and tag_map import as the old store imports them, from the legacy file and the key files', async () => {
        const keys = await setUp();
        await library.tags.markSeedPending();
        const legacy = { tags: [{ id: 'keep', name: 'Keep from settings' }, { id: 'dropped', name: 'Dropped' }, { id: 's1', name: 'zeta' }, { id: 's2', name: 'Beta', sort_order: 0.25 }, { bad: true }], tag_map: { [keys[4]]: ['s1', 's2', 'nowhere'], 'nobody.png': ['s1'] }, other: 1 };
        fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(legacy));
        const settingsDir = path.join(directories.root, 'settings');
        fs.mkdirSync(settingsDir, { recursive: true });
        const keyFiles = () => {
            fs.writeFileSync(path.join(settingsDir, 'tags.json'), JSON.stringify([{ id: 's3', name: 'from key files' }, { id: 's1', name: 'zeta again' }]));
            fs.writeFileSync(path.join(settingsDir, 'tag_map.json'), JSON.stringify({ [keys[5]]: ['s3', 'keep'] }));
        };
        keyFiles();
        await sameUuids(() => metadataDb.migrateSettingsTagsIfNeeded(directories), async () => {
            keyFiles();
            fs.rmSync(path.join(settingsDir, 'tags.json.migrated'));
            fs.rmSync(path.join(settingsDir, 'tag_map.json.migrated'));
            return library.tags.importSettingsTags(directories);
        });
        expect(fs.existsSync(path.join(settingsDir, 'tags.json'))).toBe(false);
        expect(fs.existsSync(path.join(settingsDir, 'tags.json.migrated'))).toBe(true);
        await finish();
        const ids = ['keep', 's1', 's2', 's3', 'dropped'];
        await compareReads(keys, ids, 6);
        await compareManual();
        await compareOrders(ids);
        // The legacy file stays, so neither is marked done; the seed was decided once, with a `tags` key: none.
        expect(await library.store.meta(['settings_tags_migrated', 'tags_seed_pending'])).toEqual([null, null]);
    });

    test('a new store with no settings tags gets upstream\'s default tags, once', async () => {
        await setUpEntities(rng(22), 1, 0);
        await library.tags.markSeedPending();
        await sameUuids(() => metadataDb.migrateSettingsTagsIfNeeded(directories), () => library.tags.importSettingsTags(directories));
        const names = async (/** @type {(p: any) => Promise<any>} */ query) => (await query({ sort: 'manual', pageSize: 50 })).rows.map((/** @type {any} */ t) => [t.id, t.name, t.sort_order]);
        expect(await names(p => library.tags.query(p))).toEqual(await names(p => metadataDb.queryTags(directories, p)));
        expect((await names(p => library.tags.query(p))).length).toBe(6);
        expect(await library.store.meta(['settings_tags_migrated', 'tags_seed_pending'])).toEqual([expect.any(String), null]);
        await library.tags.restartSettingsImport();
        await library.tags.importSettingsTags(directories);
        expect((await names(p => library.tags.query(p))).length).toBe(6);
    });
});
