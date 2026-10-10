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

/** Compares every read the tag manager makes, both stores. */
async function compareReads(keys, tagIds) {
    for (const sort of ['manual', 'alphabetical', 'by_entries']) {
        for (const filter of FILTERS) {
            for (const pageSize of [3, 50]) {
                const { old, eng } = await bothQueryPages({ sort, ...filter }, pageSize);
                expect({ sort, filter, ids: eng.ids }).toEqual({ sort, filter, ids: old.ids });
                if (Object.keys(filter).length === 0) expect(eng.ids.length).toBeGreaterThan(20);
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
