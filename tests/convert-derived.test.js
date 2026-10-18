// The one-off src/migrations/convert-derived.js, deleted with it. Its fixture (tests/fixtures/convert-derived/) is a
// store an engine before the one value head per field wrote (VALUE and JSON_HEAD heads, free keys by start), and what
// that engine read from it (expected.json).
import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';

// The tests' lint environment predates BigInt.
const { BigInt } = globalThis;

/** @type {any} */
let engine;
/** @type {typeof import('../src/migrations/convert-derived.js')} */
let script;
/** @type {typeof import('../src/library-engine.js')} */
let lib;
/** @type {string[]} */
const dirs = [];

const FIXTURE = path.join(process.cwd(), 'fixtures', 'convert-derived');
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'expected.json'), 'utf8'));

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    engine = (await import('../engine/load.js')).loadEngine().binding;
    script = await import('../src/migrations/convert-derived.js');
    lib = await import('../src/library-engine.js');
});

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A copy of the fixture's data root. */
function oldUser() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-derived-'));
    dirs.push(dataRoot);
    fs.cpSync(path.join(FIXTURE, 'u'), path.join(dataRoot, 'u'), { recursive: true });
    return dataRoot;
}

const quiet = { log: () => {}, warn: () => {} };
const stopped = async () => ({ running: false, lines: [] });
const ids = Object.values(expected.ids).map(BigInt);

/** What the store reads now: entities, the book, its lowest free key, old forms left. */
async function readUser(/** @type {string} */ dataRoot) {
    const library = await lib.LibraryEngine.open(engine, path.join(dataRoot, 'u', 'store'));
    try {
        const book = BigInt(expected.ids.book);
        return {
            entities: JSON.parse(JSON.stringify(await library.entities(ids), (_, v) => (typeof v === 'bigint' ? String(v) : v))),
            book: await library.books.read('b'),
            freeKey: (await library.store.worldRead('numbers', { book })).freeKey,
            pending: await library.store.convertDerivedPending(),
        };
    } finally {
        await library.close();
    }
}

describe('convert-derived', () => {
    test('a dry run writes nothing; apply moves every old entry, everything reads as before', async () => {
        const dataRoot = oldUser();
        const lines = [];
        expect(await script.runConvert({ dataRoot, handle: 'u', apply: false, engine: async () => engine, probeServer: stopped, log: l => lines.push(l), warn: l => lines.push(l) })).toBe(0);
        expect(lines.join('\n')).toMatch(/derived entries in an old form: some/);
        expect((await readUser(dataRoot)).pending).toBe(true);

        const applied = [];
        expect(await script.runConvert({ dataRoot, handle: 'u', apply: true, engine: async () => engine, probeServer: stopped, log: l => applied.push(l), warn: l => applied.push(l) })).toBe(0);
        // The character, the book and entry 0 had whole JSON values; entry 2 a JSON value with history; the book its
        // free keys 1, 3 to 4 and 6 on.
        expect(applied.join('\n')).toMatch(/moved: 4 entities' value heads and 1 books' free keys, 7 entries/);
        const after = await readUser(dataRoot);
        expect(after.pending).toBe(false);
        expect(after.entities).toEqual(expected.entities);
        expect(after.book).toEqual(expected.book);
        expect(after.freeKey).toBe(expected.freeKey);

        // A re-run moves nothing.
        const again = [];
        expect(await script.runConvert({ dataRoot, handle: 'u', apply: true, engine: async () => engine, probeServer: stopped, log: l => again.push(l), warn: l => again.push(l) })).toBe(0);
        expect(again.join('\n')).toMatch(/moved: 0 entities' value heads and 0 books' free keys, 0 entries/);
        expect((await readUser(dataRoot)).entities).toEqual(expected.entities);
    });

    test('after it, entries take and give back free keys as before', async () => {
        const dataRoot = oldUser();
        expect(await script.runConvert({ dataRoot, handle: 'u', apply: true, engine: async () => engine, probeServer: stopped, ...quiet })).toBe(0);
        const library = await lib.LibraryEngine.open(engine, path.join(dataRoot, 'u', 'store'));
        try {
            const book = BigInt(expected.ids.book);
            const free = async () => (await library.store.worldRead('numbers', { book })).freeKey;
            // Keys 0, 2 and 5 are taken.
            expect(await free()).toBe(1);
            const e = library.nextId++;
            await library.store.commit([{ kind: 'entityCreate', entity: e, type: lib.TYPE.entry, key: `${book}:1`, added: 0 }]);
            expect(await free()).toBe(3);
            await library.store.commit([{ kind: 'entityDelete', entity: BigInt(expected.ids.e0) }]);
            expect(await free()).toBe(0);
        } finally {
            await library.close();
        }
    });

    test('a field with a head and an old entry too stops it, and its entity is left whole', async () => {
        const dataRoot = oldUser();
        // Entry 0's order written with history by this engine, over its old whole value: two current values.
        const library = await lib.LibraryEngine.open(engine, path.join(dataRoot, 'u', 'store'));
        const next = await library.nextIds();
        await library.store.commit([{ kind: 'histSet', entity: BigInt(expected.ids.e0), field: 110, value: '7', json: true, id: next.change++, time: 3 }]);
        await library.close();
        const lines = [];
        expect(await script.runConvert({ dataRoot, handle: 'u', apply: true, engine: async () => engine, probeServer: stopped, log: l => lines.push(l), warn: l => lines.push(l) })).toBe(1);
        const text = lines.join('\n');
        expect(text).toMatch(new RegExp(`CONFLICT: entity ${expected.ids.e0} field Code\\(110\\)`));
        // The rest moved; entry 0 kept its old entries.
        expect(text).toMatch(/moved: 3 entities' value heads and 1 books' free keys, 6 entries/);
        expect((await readUser(dataRoot)).pending).toBe(true);
    });

    test('the server opens the store only once it has run', async () => {
        const dataRoot = oldUser();
        const stores = await import('../src/user-stores.js');
        stores.setStoreEngine(() => engine);
        const root = path.join(dataRoot, 'u');
        await expect(stores.userStore({ root })).rejects.toThrow(/derived entries in their old form/);
        expect(await script.runConvert({ dataRoot, handle: 'u', apply: true, engine: async () => engine, probeServer: stopped, ...quiet })).toBe(0);
        expect((await stores.userStore({ root })).handle).toBe('u');
        await stores.closeUserStores();
    });

    test('refused while the server runs, and without a store', async () => {
        const dataRoot = oldUser();
        const running = async () => ({ running: true, lines: ['port probe 127.0.0.1:8000: in-use'] });
        expect(await script.runConvert({ dataRoot, handle: 'u', apply: true, engine: async () => engine, probeServer: running, ...quiet })).toBe(1);
        expect((await readUser(dataRoot)).pending).toBe(true);
        expect(await script.runConvert({ dataRoot, handle: 'nobody', apply: true, engine: async () => engine, probeServer: stopped, ...quiet })).toBe(1);
    });

    test('arguments', () => {
        expect(script.parseArgs(['--apply', '--handle', 'x'])).toMatchObject({ apply: true, dryRun: false, handle: 'x', unknown: [] });
        expect(script.parseArgs(['--what'])).toMatchObject({ unknown: ['--what'] });
    });
});
