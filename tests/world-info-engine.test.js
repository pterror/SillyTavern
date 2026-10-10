import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * World info on the engine (src/world-info-engine.js) against the old store's routes (src/endpoints/worldinfo.js)
 * for the same writes: books read back, the books list, `/entries/apply`, `/entry/create`, `/entry/edit`,
 * `/entry/transplant`, `/duplicate`, `/delete`; and what only the engine has: what a write records, characters'
 * embedded books, lorebook links by id.
 */

/** @type {typeof import('../src/library-engine.js')} */
let lib;
/** @type {typeof import('../public/scripts/hash-utils.js')} */
let hashUtils;
/** @type {any} */
let oldRouter;
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
    oldRouter = (await import('../src/endpoints/worldinfo.js')).router;
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

/** An old route's answer: `{ status, body }` (the body as JSON carries it). */
function old(route, body) {
    return new Promise((resolve, reject) => {
        const req = { method: 'POST', url: route, body, user: { directories }, headers: {} };
        const res = {
            statusCode: 200,
            status(c) {
                this.statusCode = c;
                return this;
            },
            send(b) {
                resolve({ status: this.statusCode, body: b === undefined ? undefined : JSON.parse(JSON.stringify(b)) });
            },
            sendStatus(c) {
                resolve({ status: c });
            },
            setHeader() {},
        };
        oldRouter.handle(req, res, (/** @type {any} */ err) => (err ? reject(err) : reject(new Error(`no route ${route}`))));
    });
}

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

/** Reads a book both ways and checks they agree. */
async function same(name) {
    const want = (await old('/get', { name })).body;
    const got = await books.read(name);
    if (!want || Object.keys(want).length === 1 && Object.keys(want.entries ?? {}).length === 0 && !fs.existsSync(path.join(directories.worlds, `${name}.json`))) {
        expect(got).toBeNull();
        return null;
    }
    expectSameBook(JSON.parse(JSON.stringify(got)), want);
    return got;
}

describe.each(['native', 'wasm'])('%s', (kind) => {
    beforeAll(() => {
        engine = engines[kind];
    });

    describe('world books against the old store', () => {
        test('books read back as written, with every key order kept', async () => {
            const r = rng(5);
            for (let b = 0; b < 8; b++) {
                const name = `Book ${b}`;
                const data = makeBook(r, 3 + Math.floor(r() * 25));
                expect((await old('/create', { name, unique: false, data })).status).toBe(200);
                await books.write(name, data);
                const got = await same(name);
                // The engine keeps the book's own key order too (the old store moved `entries` last).
                expect(Object.keys(/** @type {object} */ (got))).toEqual(Object.keys(data));
            }
            const list = await books.list();
            expect(list).toEqual((await old('/list', {})).body);
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
            await old('/create', { name: 'B', unique: false, replace: true, data: next });
            await same('B');
        }, 120_000);

        test('entry actions answer as the old routes do', async () => {
            const r = rng(13);
            const a = makeBook(r, 12);
            const b = makeBook(r, 6);
            delete a.originalData;
            for (const [name, data] of [['A', a], ['B', b]]) {
                await old('/create', { name, unique: false, data });
                await books.write(name, data);
            }
            for (let step = 0; step < 120; step++) {
                const name = r() < 0.5 ? 'A' : 'B';
                const current = (await old('/get', { name })).body;
                const uids = Object.keys(current.entries);
                const uid = uids[Math.floor(r() * uids.length)];
                const op = Math.floor(r() * 5);
                /** Each action's answer, the engine's and the old route's. */
                let got;
                let want;
                if (op === 0) {
                    want = { entry: (await old('/entry/create', { name })).body.entry };
                    got = await books.createEntry(name);
                } else if (op === 1 && uid !== undefined) {
                    const data = { ...current.entries[uid], content: `edited ${step}`, order: step };
                    want = { entry: (await old('/entry/edit', { name, uid, data })).body.entry };
                    got = JSON.parse(JSON.stringify(await books.editEntry(name, uid, data)));
                } else if (op === 2 && uid !== undefined) {
                    const target = name === 'A' ? 'B' : 'A';
                    const deleteOriginal = r() < 0.5;
                    want = { entry: (await old('/entry/transplant', { source_name: name, target_name: target, uid, delete_original: deleteOriginal })).body.entry };
                    got = await books.transplant({ source: name, target, uid, deleteOriginal });
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
                    want = (await old('/entries/apply', { name, entries, fields })).body;
                    got = JSON.parse(JSON.stringify(await books.apply(name, entries, fields)));
                } else if (op === 4) {
                    const data = JSON.parse(JSON.stringify(current));
                    if (uid !== undefined) data.entries[uid].content = `whole ${step}`;
                    await old('/edit', { name, data });
                    await books.write(name, data);
                }
                expect(got).toEqual(want);
                await same('A');
                await same('B');
            }
        }, 120_000);

        test('originalData follows an entry deleted through apply', async () => {
            const r = rng(21);
            let data;
            do data = makeBook(r, 5); while (!data.originalData);
            await old('/create', { name: 'O', unique: false, data });
            await books.write('O', data);
            const current = (await old('/get', { name: 'O' })).body;
            const uid = Object.keys(current.entries)[0];
            const entries = [{ uid, base_hash: hashUtils.jsonHash(current.entries[uid]), data: null }];
            expect(JSON.parse(JSON.stringify(await books.apply('O', entries, [])))).toEqual((await old('/entries/apply', { name: 'O', entries, fields: [] })).body);
            await same('O');
        }, 120_000);

        test('duplicate and delete', async () => {
            const r = rng(3);
            const data = makeBook(r, 7);
            await old('/create', { name: 'D', unique: false, data });
            await books.write('D', data);
            await old('/duplicate', { name: 'D', new_name: 'D2' });
            await books.write('D2', /** @type {object} */ (await books.read('D')));
            await same('D2');
            await old('/delete', { name: 'D' });
            expect(await books.delete('D')).toBe(true);
            expect(await books.read('D')).toBeNull();
            expect(await books.exists('D')).toBe(false);
            expect(await books.list()).toEqual((await old('/list', {})).body);
            // Written again under the name, the book is new.
            await books.write('D', { entries: {} });
            expect(await books.read('D')).toEqual({ entries: {} });
        }, 120_000);
    });

    describe('what only the engine has', () => {
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
            const card = (/** @type {string} */ world) => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'C', extensions: { world } } });
            const worldOf = async (/** @type {string} */ avatar) => /** @type {any} */ ((await library.cards([avatar]))[0]).data.extensions.world;
            const linked = async (/** @type {string} */ world) => (await library.query({ world, wantRows: false, wantHashes: true })).hashRows.map((/** @type {any} */ row) => row.id).sort();
            await books.write('Lore', { entries: {} });
            await library.writeCard(directories, 'a.png', card('Lore'));
            await library.writeCard(directories, 'b.png', card('Ghost'));
            expect(await linked('Lore')).toEqual(['a.png']);
            expect(await linked('Ghost')).toEqual(['b.png']);
            const before = (await library.query({ ids: ['a.png'], wantRows: false, wantHashes: true })).hashRows[0].version;
            expect(await books.rename('Lore', 'Lore 2')).toBe('ok');
            expect(await worldOf('a.png')).toBe('Lore 2');
            expect(await linked('Lore 2')).toEqual(['a.png']);
            expect(await linked('Lore')).toEqual([]);
            const after = (await library.query({ ids: ['a.png'], wantRows: false, wantHashes: true })).hashRows[0].version;
            expect(after).toBeGreaterThan(before);
            // Renamed onto the unresolved name, the book takes its links.
            expect(await books.rename('Lore 2', 'Ghost')).toBe('ok');
            expect(await worldOf('a.png')).toBe('Ghost');
            expect(await worldOf('b.png')).toBe('Ghost');
            expect(await linked('Ghost')).toEqual(['a.png', 'b.png']);
            // Deleted, the links keep the name; a book taking the name again resolves them.
            expect(await books.delete('Ghost')).toBe(true);
            expect(await worldOf('a.png')).toBe('Ghost');
            expect(await linked('Ghost')).toEqual(['a.png', 'b.png']);
            expect(await books.exists('Ghost')).toBe(false);
            await books.write('Ghost', { entries: {} });
            expect(await books.rename('Ghost', 'Found')).toBe('ok');
            expect(await worldOf('b.png')).toBe('Found');
            // A card saved with the name it already reads as writes nothing for its link (its identity hash, made when
            // it read 'Ghost', is written once).
            await library.writeCard(directories, 'b.png', card('Found'));
            expect((await library.writeCard(directories, 'b.png', card('Found'))).records).toBe(0);
            expect(await books.rename('Found', 'Found')).toBe('ok');
            await books.write('Other', { entries: {} });
            expect(await books.rename('Other', 'Found')).toBe('taken');
        }, 120_000);
    });
});
