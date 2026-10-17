// The one-off src/migrations/convert-entries-to-history.js, deleted with it.
import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';

/** @type {any} */
let engine;
/** @type {typeof import('../src/migrations/convert-entries-to-history.js')} */
let script;
/** @type {typeof import('../src/library-engine.js')} */
let lib;
/** @type {string[]} */
const dirs = [];

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    engine = (await import('../engine/load.js')).loadEngine().binding;
    script = await import('../src/migrations/convert-entries-to-history.js');
    lib = await import('../src/library-engine.js');
});

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Field codes of an entry's keys (`ENTRY_KEYS` in src/world-info-engine.js). */
const CONTENT = 104;
const ORDER = 110;
/** An entry's `key` list, item 1's text. */
const KEY_ITEM = 1024 + 1 * 8 + 0;

/**
 * A data root whose user `u` has a store as the server left it before history: a world book `b` with entries 0 (its
 * text edited once, a JSON value, a key list item) and 1 (one value written since with its history), and a
 * character's own book with one entry.
 */
async function oldUser() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-entries-to-history-'));
    dirs.push(dataRoot);
    const root = path.join(dataRoot, 'u');
    const library = await lib.LibraryEngine.open(engine, path.join(root, 'store'));
    const [book, e0, e1, owned, e2] = [library.nextId++, library.nextId++, library.nextId++, library.nextId++, library.nextId++];
    const text = (/** @type {bigint} */ entity, /** @type {number} */ field, /** @type {string} */ t) => ({ kind: 'textValue', entity, field, text: t });
    const json = (/** @type {bigint} */ entity, /** @type {number} */ field, /** @type {string} */ j) => ({ kind: 'jsonValue', entity, field, json: j });
    const place = (/** @type {bigint} */ entity, /** @type {number} */ list, /** @type {bigint | number} */ item, /** @type {number} */ position) => ({ kind: 'itemPlace', entity, list, item, position });
    await library.store.commit([
        json(book, 41, ''),
        { kind: 'entityCreate', entity: book, type: lib.TYPE.book, key: 'b', added: 0 },
        text(e0, CONTENT, 'A dragon sleeps.'),
        json(e0, ORDER, '100'),
        text(e0, KEY_ITEM, 'dragon'),
        place(e0, 0, 1, 1048576),
        { kind: 'entityCreate', entity: e0, type: lib.TYPE.entry, key: `${book}:0`, added: 0 },
        place(book, 0, e0, 1048576),
        text(e1, CONTENT, 'The knight keeps watch.'),
        json(e1, ORDER, '100'),
        { kind: 'entityCreate', entity: e1, type: lib.TYPE.entry, key: `${book}:1`, added: 0 },
        place(book, 0, e1, 2097152),
        { kind: 'entityCreate', entity: owned, type: lib.TYPE.ownedBook, key: '99:c', added: 0 },
        text(e2, CONTENT, 'Its own lore.'),
        { kind: 'entityCreate', entity: e2, type: lib.TYPE.entry, key: `${owned}:0`, added: 0 },
        place(owned, 0, e2, 1048576),
    ]);
    await library.store.commit([{ kind: 'textEdit', entity: e0, field: CONTENT, offset: 2, removed: 6, text: 'wyrm' }]);
    // Entry 1's order written by the server with history already.
    const next = await library.nextIds();
    await library.store.commit([{ kind: 'histSet', entity: e1, field: ORDER, value: '101', json: true, id: next.change++, time: 1 }]);
    const books = await library.books.read('b');
    await library.close();
    return { dataRoot, books, ids: { e0, e1, e2 } };
}

const quiet = { log: () => {}, warn: () => {} };
const stopped = async () => ({ running: false, lines: [] });

/** What the store holds after a run: the book as read, entries' history, what is left from before. */
async function readUser(dataRoot, ids) {
    const library = await lib.LibraryEngine.open(engine, path.join(dataRoot, 'u', 'store'));
    try {
        const kinds = async (/** @type {bigint} */ e, /** @type {number} */ f) => (await library.books.history(e, f)).changes.map((/** @type {any} */ c) => [c.kind, c.user]);
        return {
            book: await library.books.read('b'),
            e0: { content: await kinds(ids.e0, CONTENT), order: await kinds(ids.e0, ORDER), key: await kinds(ids.e0, KEY_ITEM) },
            e1: { order: await kinds(ids.e1, ORDER), content: await kinds(ids.e1, CONTENT) },
            e2: await kinds(ids.e2, CONTENT),
            left: (await library.store.worldRead('legacyEntries', { limit: 10 })).entries.length,
        };
    } finally {
        await library.close();
    }
}

describe('convert-entries-to-history', () => {
    test('a dry run writes nothing; apply gives every value its first change, the same values read back', async () => {
        const { dataRoot, books, ids } = await oldUser();
        const lines = [];
        expect(await script.runConvert({ dataRoot, handle: 'u', apply: false, engine: async () => engine, probeServer: stopped, log: l => lines.push(l), warn: l => lines.push(l) })).toBe(0);
        expect(lines.join('\n')).toMatch(/entries with values from before history: 3; the apply would write: 5 values and 1 places/);
        expect((await readUser(dataRoot, ids)).left).toBe(3);

        expect(await script.runConvert({ dataRoot, handle: 'u', apply: true, engine: async () => engine, probeServer: stopped, ...quiet })).toBe(0);
        const after = await readUser(dataRoot, ids);
        expect(after.left).toBe(0);
        expect(after.book).toEqual(books);
        expect(after.book?.entries[0].content).toBe('A wyrm sleeps.');
        // The first changes of what was there: by no one known; the change made with history before stays.
        expect(after.e0).toEqual({ content: [['set', null]], order: [['set', null]], key: [['place', null], ['set', null]] });
        expect(after.e1.order).toEqual([['set', null]]);
        expect(after.e1.content).toEqual([['set', null]]);
        expect(after.e2).toEqual([['set', null]]);

        // A re-run writes nothing.
        const again = [];
        expect(await script.runConvert({ dataRoot, handle: 'u', apply: true, engine: async () => engine, probeServer: stopped, log: l => again.push(l), warn: l => again.push(l) })).toBe(0);
        expect(again.join('\n')).toMatch(/entries with values from before history: 0; written: 0 values and 0 places/);
        expect((await readUser(dataRoot, ids)).book).toEqual(books);
    });

    test('refused while the server runs, and without a store', async () => {
        const { dataRoot, ids } = await oldUser();
        const running = async () => ({ running: true, lines: ['port probe 127.0.0.1:8000: in-use'] });
        expect(await script.runConvert({ dataRoot, handle: 'u', apply: true, engine: async () => engine, probeServer: running, ...quiet })).toBe(1);
        expect((await readUser(dataRoot, ids)).left).toBe(3);
        expect(await script.runConvert({ dataRoot, handle: 'nobody', apply: true, engine: async () => engine, probeServer: stopped, ...quiet })).toBe(1);
    });

    test('arguments', () => {
        expect(script.parseArgs(['--apply', '--handle', 'x'])).toMatchObject({ apply: true, dryRun: false, handle: 'x', unknown: [] });
        expect(script.parseArgs(['--what'])).toMatchObject({ unknown: ['--what'] });
    });
});
