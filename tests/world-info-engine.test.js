import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * World info on the engine (src/world-info-engine.js): books read back as written, the books list, and the entry
 * actions (`/entries/apply`, `/entry/create`, `/entry/edit`, `/entry/transplant`, `/duplicate`, `/delete`) against a
 * model of what each route does to a book; and what a write records, characters' embedded books, lorebook links by
 * id.
 */

/** @type {typeof import('../src/library-engine.js')} */
let lib;
/** @type {typeof import('../public/scripts/hash-utils.js')} */
let hashUtils;
/** @type {any} */
let engine;
/** @type {Record<string, any>} */
const engines = {};
/** @type {any} */
let directories;
/** @type {import('../src/library-engine.js').LibraryEngine} */
let library;
/** @type {import('../src/world-info-engine.js').WorldInfoEngine} */
let books;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    lib = await import('../src/library-engine.js');
    hashUtils = await import('../public/scripts/hash-utils.js');
    const { loadEngine } = await import('../engine/load.js');
    engines.native = loadEngine().binding;
    engines.wasm = loadEngine({ platform: null }).binding;
});

beforeEach(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-world-info-engine-test-'));
    directories = { root: tempDir, worlds: path.join(tempDir, 'worlds'), characters: path.join(tempDir, 'characters') };
    fs.mkdirSync(directories.worlds, { recursive: true });
    fs.mkdirSync(directories.characters, { recursive: true });
    library = await lib.LibraryEngine.open(engine, path.join(tempDir, 'store'));
    books = library.books;
});

afterEach(async () => {
    await library.close();
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

const WORDS = ['dragon', 'castle', 'Émile', 'the', 'quiet', '😀', 'knight', 'a\u{1F600}b', ''];

/** A varied entry: upstream's keys in its order or shuffled, lists empty or not, unknown keys, odd values. */
function makeEntry(r, uid) {
    const pick = (/** @type {any[]} */ list) => list[Math.floor(r() * list.length)];
    const words = (/** @type {number} */ n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
    /** @type {Record<string, unknown>} */
    const e = {};
    if (r() < 0.9) e.uid = r() < 0.9 ? uid : `${uid}`;
    e.key = r() < 0.8 ? [words(1), words(2)] : [];
    e.keysecondary = r() < 0.3 ? [words(1)] : [];
    e.comment = words(Math.floor(r() * 4));
    e.content = words(5 + Math.floor(r() * 40));
    e.constant = r() < 0.2;
    e.selective = r() < 0.5;
    e.order = Math.floor(r() * 200);
    e.position = Math.floor(r() * 5);
    e.disable = false;
    e.probability = 100;
    e.depth = 4;
    e.group = r() < 0.2 ? 'weather' : '';
    e.scanDepth = r() < 0.5 ? null : 2;
    if (r() < 0.8) e.displayIndex = r() < 0.9 ? Math.floor(r() * 50) : pick(['3', null, 'x', [7]]);
    if (r() < 0.2) e.characterFilter = { isExclude: false, names: [words(1)], tags: [] };
    if (r() < 0.2) e.extensions = { custom: { a: 1 } };
    if (r() < 0.15) e.someExtensionKey = { nested: [1, 'two'] };
    if (r() < 0.1) e.triggers = ['normal'];
    if (r() < 0.2) {
        const keys = Object.keys(e);
        const shuffled = keys.sort(() => r() - 0.5);
        return Object.fromEntries(shuffled.map(k => [k, e[k]]));
    }
    return e;
}

/** A varied book: integer and text keys, book fields before or after `entries`, an `originalData`. */
function makeBook(r, n) {
    /** @type {Record<string, unknown>} */
    const entries = {};
    for (let i = 0; i < n; i++) {
        const k = r() < 0.9 ? i * (r() < 0.3 ? 3 : 1) : `k${i}`;
        entries[k] = makeEntry(r, typeof k === 'number' ? k : i);
    }
    /** @type {Record<string, unknown>} */
    const book = r() < 0.5 ? { entries, name: 'Display' } : { name: 'Display', extensions: { x: 1 }, entries };
    if (r() < 0.3) {
        book.originalData = {
            name: 'card book',
            extensions: {},
            entries: Object.values(entries).slice(0, 3).map((e, i) => ({ id: i, uid: /** @type {any} */ (e).uid, keys: ['k'], content: 'c', enabled: true, insertion_order: 100, extensions: {} })),
        };
    }
    return book;
}

/** The same book: every key's value equal (JSON, key order within included) and the same keys. */
function expectSameBook(got, want) {
    expect(got).not.toBeNull();
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const k of Object.keys(want)) {
        if (k === 'entries') {
            expect(Object.keys(got.entries)).toEqual(Object.keys(want.entries));
            for (const uid of Object.keys(want.entries)) expect(JSON.stringify(got.entries[uid])).toBe(JSON.stringify(want.entries[uid]));
        } else {
            expect(JSON.stringify(got[k])).toBe(JSON.stringify(want[k]));
        }
    }
}

/** As JSON carries it. */
const json = (/** @type {unknown} */ v) => JSON.parse(JSON.stringify(v));

/** The lowest non-negative integer that isn't a key of `entries`. */
function freeKey(entries) {
    let k = 0;
    while (Object.hasOwn(entries, String(k))) k++;
    return k;
}

/** The model of `/entries/apply` on a book (upstream's page actions against their versions); answers as the route. */
function modelApply(book, entryChanges, fieldChanges) {
    const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
    const hash = (/** @type {unknown} */ v) => (v === undefined ? null : hashUtils.jsonHash(v));
    const entries = {};
    const deleted = [];
    const fields = {};
    const conflicts = [];
    const deletedUids = [];
    for (const change of entryChanges) {
        const k = String(change.uid);
        const cur = book.entries[k];
        const next = isObject(change.data) ? json({ ...change.data, uid: cur?.uid ?? change.uid }) : undefined;
        if (hash(cur) === hash(next)) continue;
        if (hash(cur) !== (change.base_hash ?? null)) {
            conflicts.push({ uid: k, current: cur ?? null });
            continue;
        }
        if (next) {
            book.entries[k] = next;
            entries[k] = next;
        } else {
            delete book.entries[k];
            deleted.push(k);
            deletedUids.push(change.uid);
        }
    }
    for (const change of fieldChanges) {
        const cur = book[change.key];
        const next = change.value ?? undefined;
        if (hash(cur) === hash(next)) continue;
        if (hash(cur) !== (change.base_hash ?? null)) {
            conflicts.push({ key: change.key, current: cur ?? null });
            continue;
        }
        if (next === undefined) delete book[change.key]; else book[change.key] = json(next);
        fields[change.key] = next ?? null;
    }
    const original = book.originalData;
    if (deletedUids.length > 0 && original && Array.isArray(original.entries)) {
        // eslint-disable-next-line eqeqeq
        original.entries = original.entries.filter((/** @type {any} */ item) => !deletedUids.some(uid => item?.uid == uid));
    }
    return json({ ok: true, entries, deleted, fields, conflicts });
}

describe.each(['native', 'wasm'])('%s', (kind) => {
    beforeAll(() => {
        engine = engines[kind];
    });

    describe('world books against a model of the routes', () => {
        /** Reads a book and checks it is the model's. */
        async function same(name, want) {
            expectSameBook(json(await books.read(name)), want);
        }

        test('books read back as written, with every key order kept, and listed by file name', async () => {
            const r = rng(5);
            const want = [];
            for (let b = 0; b < 8; b++) {
                const name = `Book ${b}`;
                const data = makeBook(r, 3 + Math.floor(r() * 25));
                await books.write(name, data);
                await same(name, json(data));
                expect(Object.keys(/** @type {object} */ (await books.read(name)))).toEqual(Object.keys(data));
                want.push({ file_id: name, name: 'Display', extensions: data.extensions ?? {} });
            }
            want.sort((a, b) => `${a.file_id}.json`.localeCompare(`${b.file_id}.json`));
            expect(await books.list()).toEqual(want);
        }, 120_000);

        test('a whole-book write records only what differs', async () => {
            const r = rng(9);
            const data = makeBook(r, 40);
            await books.write('B', data);
            expect((await books.write('B', JSON.parse(JSON.stringify(data)))).records).toBe(0);
            const next = JSON.parse(JSON.stringify(data));
            const uid = Object.keys(next.entries)[3];
            next.entries[uid].content += ' more';
            expect((await books.write('B', next)).records).toBe(1);
            next.entries[uid].order = 7;
            delete next.entries[Object.keys(next.entries)[5]];
            expect((await books.write('B', next)).records).toBe(2);
            await same('B', next);
        }, 120_000);

        test('entry actions answer and store as the routes do', async () => {
            const r = rng(13);
            const a = makeBook(r, 12);
            const b = makeBook(r, 6);
            delete a.originalData;
            /** @type {Record<string, any>} */
            const model = { A: json(a), B: json(b) };
            await books.write('A', a);
            await books.write('B', b);
            for (let step = 0; step < 120; step++) {
                const name = r() < 0.5 ? 'A' : 'B';
                const current = model[name];
                const uids = Object.keys(current.entries);
                const uid = uids[Math.floor(r() * uids.length)];
                const op = Math.floor(r() * 5);
                let got;
                let want;
                if (op === 0) {
                    const k = freeKey(current.entries);
                    current.entries[k] = { uid: k };
                    want = { entry: { uid: k } };
                    got = await books.createEntry(name);
                } else if (op === 1 && uid !== undefined) {
                    const data = { ...current.entries[uid], content: `edited ${step}`, order: step };
                    const entry = json({ ...data, uid: current.entries[uid].uid });
                    current.entries[uid] = entry;
                    want = { entry };
                    got = json(await books.editEntry(name, uid, data));
                } else if (op === 2 && uid !== undefined) {
                    const target = model[name === 'A' ? 'B' : 'A'];
                    const deleteOriginal = r() < 0.5;
                    const k = freeKey(target.entries);
                    const moved = { ...current.entries[uid] };
                    moved.uid = k;
                    const indexes = Object.values(target.entries).flatMap((/** @type {any} */ e) => (e.displayIndex != null ? [Number(e.displayIndex)] : []));
                    moved.displayIndex = Math.max(-1, ...indexes) + 1;
                    want = { entry: json(moved) };
                    target.entries[k] = json(moved);
                    if (deleteOriginal) delete current.entries[uid];
                    got = await books.transplant({ source: name, target: name === 'A' ? 'B' : 'A', uid, deleteOriginal });
                } else if (op === 3) {
                    // Changes against the page's versions, some stale.
                    const entries = [];
                    for (const u of uids.slice(0, 3)) {
                        const stale = r() < 0.2;
                        const base = stale ? 12345 : hashUtils.jsonHash(current.entries[u]);
                        entries.push(r() < 0.3 ? { uid: u, base_hash: base, data: null } : { uid: u, base_hash: base, data: { ...current.entries[u], comment: `c${step}` } });
                    }
                    const fresh = Number(uids.length ? Math.max(...uids.map(Number).filter(Number.isFinite)) + 100 + step : 500 + step);
                    entries.push({ uid: fresh, base_hash: null, data: makeEntry(r, fresh) });
                    const fields = [{ key: 'name', base_hash: hashUtils.jsonHash(current.name), value: `Renamed ${step}` }];
                    if (r() < 0.3) fields.push({ key: 'extensions', base_hash: 1, value: { y: 2 } });
                    want = modelApply(current, entries, fields);
                    got = json(await books.apply(name, entries, fields));
                } else if (op === 4) {
                    const data = json(current);
                    if (uid !== undefined) data.entries[uid].content = `whole ${step}`;
                    model[name] = json(data);
                    await books.write(name, data);
                }
                expect(got).toEqual(want);
                await same('A', model.A);
                await same('B', model.B);
            }
        }, 120_000);

        test('originalData follows an entry deleted through apply', async () => {
            const r = rng(21);
            let data;
            do data = makeBook(r, 5); while (!data.originalData);
            await books.write('O', data);
            const current = json(data);
            const uid = Object.keys(current.entries)[0];
            const entries = [{ uid, base_hash: hashUtils.jsonHash(current.entries[uid]), data: null }];
            const want = modelApply(current, entries, []);
            expect(json(await books.apply('O', entries, []))).toEqual(want);
            await same('O', current);
        }, 120_000);

        test('duplicate and delete', async () => {
            const r = rng(3);
            const data = makeBook(r, 7);
            await books.write('D', data);
            await books.write('D2', /** @type {object} */ (await books.read('D')));
            await same('D2', json(data));
            expect(await books.delete('D')).toBe(true);
            expect(await books.read('D')).toBeNull();
            expect(await books.exists('D')).toBe(false);
            expect((await books.list()).map(b => b.file_id)).toEqual(['D2']);
            // Written again under the name, the book is new.
            await books.write('D', { entries: {} });
            expect(await books.read('D')).toEqual({ entries: {} });
        }, 120_000);
    });


    describe('what only the engine has', () => {
        test('a chat-bound lorebook follows its book', async () => {
            const { ChatEngine } = await import('../src/chat-engine.js');
            const { libraryPeople } = await import('../src/chat-people.js');
            await library.writeCard(directories, 'c.png', JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'C', extensions: {} } }));
            const [tree] = await library.ids(lib.TYPE.character, ['c.png']);
            const chats = await ChatEngine.open(library.store, libraryPeople(library));
            const actor = { user: 'u' };
            const lorebook = async () => (await chats.metadata(/** @type {bigint} */ (tree), null)).world_info;
            await books.write('Lore', { entries: {} });
            await chats.mergeMetadata({ tree, at: null, set: { world_info: 'Lore', other: 1 }, unset: [], actor });
            expect(await lorebook()).toBe('Lore');
            await books.rename('Lore', 'Lore 2');
            expect(await lorebook()).toBe('Lore 2');
            // Set to the name it reads as, nothing is recorded.
            expect((await chats.changeState({ tree, at: null, ops: [{ key: 'world_info', value: 'Lore 2' }], actor })).changes).toEqual([]);
            await books.delete('Lore 2');
            expect(await lorebook()).toBe('Lore 2');
            // A name no book has resolves once a book takes it.
            const ghost = await chats.changeState({ tree, at: null, ops: [{ key: 'world_info', value: 'Ghost' }], actor });
            expect(await lorebook()).toBe('Ghost');
            await books.write('Ghost', { entries: {} });
            await books.rename('Ghost', 'Found');
            expect(await lorebook()).toBe('Found');
            await chats.revertChange({ change: /** @type {any} */ (ghost).changes[0], actor });
            expect(await lorebook()).toBe('Lore 2');
            await chats.mergeMetadata({ tree, at: null, set: { world_info: 'a/b' }, unset: [], actor });
            expect(await lorebook()).toBe('a/b');
            await chats.mergeMetadata({ tree, at: null, set: { world_info: null }, unset: [], actor });
            expect(await lorebook()).toBeNull();
            await chats.mergeMetadata({ tree, at: null, set: {}, unset: ['world_info'], actor });
            expect(await chats.metadata(/** @type {bigint} */ (tree), null)).toEqual({ other: 1 });
        }, 120_000);

        test('a large book is written and edited one entry at a time', async () => {
            const entries = Object.fromEntries(Array.from({ length: 12_000 }, (_, i) => [i, { uid: i, key: [`k${i}`], content: `c${i}`, displayIndex: i }]));
            await books.write('Big', { entries });
            const read = /** @type {any} */ (await books.read('Big'));
            expect(Object.keys(read.entries).length).toBe(12_000);
            expect(await books.editEntry('Big', 6000, { ...entries[6000], content: 'changed' })).toEqual({ entry: { ...entries[6000], content: 'changed' } });
            expect((await books.write('Big', { entries: { ...entries, 6000: { ...entries[6000], content: 'changed' } } })).records).toBe(0);
        }, 300_000);

        test('a name sanitize changes finds the same book', async () => {
            await books.write('a/b', { entries: {} });
            expect(await books.exists('ab')).toBe(true);
            expect(await books.read('a/b')).toEqual({ entries: {} });
        });

        test('a character\'s embedded book round-trips and an entry edit writes that entry only', async () => {
            const r = rng(17);
            const entries = Array.from({ length: 6 }, (_, i) => ({ keys: [`k${i}`], content: `c${i}`, extensions: { depth: i }, enabled: true, insertion_order: i, ...(i % 2 ? { id: i } : {}) }));
            const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'C', description: 'd', extensions: {}, character_book: { name: 'cb', entries, extensions: {} } } };
            await library.writeCard(directories, 'c.png', JSON.stringify(card));
            const [read] = await library.cards(['c.png']);
            expect(JSON.stringify(/** @type {any} */ (read).data.character_book)).toBe(JSON.stringify(card.data.character_book));
            const next = JSON.parse(JSON.stringify(card));
            next.data.character_book.entries[2].content = 'changed';
            const { records } = await library.writeCard(directories, 'c.png', JSON.stringify(next));
            // The entry's edit and the card's identity hash.
            expect(records).toBe(2);
            next.data.character_book.entries.splice(1, 0, { keys: ['new'], content: 'n' });
            next.data.character_book.entries.pop();
            await library.writeCard(directories, 'c.png', JSON.stringify(next));
            const [again] = await library.cards(['c.png']);
            expect(JSON.stringify(/** @type {any} */ (again).data.character_book)).toBe(JSON.stringify(next.data.character_book));
            // A character_book that isn't a list of entries is kept as it came.
            const odd = { ...next, data: { ...next.data, character_book: { entries: 'none' } } };
            await library.writeCard(directories, 'c.png', JSON.stringify(odd));
            expect(/** @type {any} */ ((await library.cards(['c.png']))[0]).data.character_book).toEqual({ entries: 'none' });
            expect(await books.owned((await library.ids(lib.TYPE.character, ['c.png']))[0], 'c')).toBeUndefined();
            expect(r()).toBeLessThan(1);
        }, 120_000);

        test('links follow a rename, survive a delete and resolve when a book takes the name', async () => {
            const card = (/** @type {string} */ world, name = 'A') => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name, extensions: { world } } });
            const worldOf = async (/** @type {string} */ avatar) => /** @type {any} */ ((await library.cards([avatar]))[0]).data.extensions.world;
            const linked = async (/** @type {string} */ world) => (await library.query({ world, wantRows: false, wantHashes: true })).hashRows.map((/** @type {any} */ row) => row.id).sort();
            const { computeContentIdentityHash } = await import('../src/character-card-normalize.js');
            /** Each card's stored identity hash is its card's as it reads now: import dedup finds it by that. */
            const hashesCurrent = async () => {
                for (const avatar of ['a.png', 'b.png']) {
                    const [read] = await library.cards([avatar]);
                    expect(await library.findByHash(lib.HASH.identity, computeContentIdentityHash(read))).toBe(avatar);
                }
            };
            await books.write('Lore', { entries: {} });
            await library.writeCard(directories, 'a.png', card('Lore'));
            await library.writeCard(directories, 'b.png', card('Ghost', 'B'));
            expect(await linked('Lore')).toEqual(['a.png']);
            expect(await linked('Ghost')).toEqual(['b.png']);
            const before = (await library.query({ ids: ['a.png'], wantRows: false, wantHashes: true })).hashRows[0].version;
            expect(await books.rename('Lore', 'Lore 2')).toBe('ok');
            expect(await worldOf('a.png')).toBe('Lore 2');
            expect(await linked('Lore 2')).toEqual(['a.png']);
            expect(await linked('Lore')).toEqual([]);
            const after = (await library.query({ ids: ['a.png'], wantRows: false, wantHashes: true })).hashRows[0].version;
            expect(after).toBeGreaterThan(before);
            await hashesCurrent();
            // The hash made from the old name no longer finds the card.
            expect(await library.findByHash(lib.HASH.identity, computeContentIdentityHash(JSON.parse(card('Lore'))))).toBeNull();
            // Renamed onto the unresolved name, the book takes its links.
            expect(await books.rename('Lore 2', 'Ghost')).toBe('ok');
            expect(await worldOf('a.png')).toBe('Ghost');
            expect(await worldOf('b.png')).toBe('Ghost');
            expect(await linked('Ghost')).toEqual(['a.png', 'b.png']);
            await hashesCurrent();
            // Deleted, the links keep the name; a book taking the name again resolves them.
            expect(await books.delete('Ghost')).toBe(true);
            expect(await worldOf('a.png')).toBe('Ghost');
            expect(await linked('Ghost')).toEqual(['a.png', 'b.png']);
            expect(await books.exists('Ghost')).toBe(false);
            await hashesCurrent();
            await books.write('Ghost', { entries: {} });
            expect(await books.rename('Ghost', 'Found')).toBe('ok');
            expect(await worldOf('b.png')).toBe('Found');
            await hashesCurrent();
            // A card saved with the name it already reads as writes nothing.
            expect((await library.writeCard(directories, 'b.png', card('Found', 'B'))).records).toBe(0);
            expect(await books.rename('Found', 'Found')).toBe('ok');
            await books.write('Other', { entries: {} });
            expect(await books.rename('Other', 'Found')).toBe('taken');
            // Renamed without relinking (upstream's relink_characters: false): the cards keep the old name, now an
            // unresolved link; a book taking the old name again resolves them.
            expect(await books.rename('Found', 'Moved', { relink: false })).toBe('ok');
            expect(await worldOf('a.png')).toBe('Found');
            expect(await worldOf('b.png')).toBe('Found');
            expect(await linked('Moved')).toEqual([]);
            expect(await linked('Found')).toEqual(['a.png', 'b.png']);
            expect(await books.exists('Found')).toBe(false);
            await hashesCurrent();
            await books.write('Found', { entries: {} });
            expect(await linked('Found')).toEqual(['a.png', 'b.png']);
        }, 120_000);
    });
});
