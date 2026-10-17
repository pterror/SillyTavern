import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * A world book's entries keep their history (src/world-info-engine.js over `store::history`): each committed write a
 * change with its user, session and time; JSON values diffed; deletes restored; reverts; forgetting with a marker or
 * without a trace.
 */

/** @type {typeof import('../src/library-engine.js')} */
let lib;
/** @type {any} */
let engine;
/** @type {import('../src/library-engine.js').LibraryEngine} */
let library;
/** @type {import('../src/world-info-engine.js').WorldInfoEngine} */
let books;
/** @type {string} */
let dir;

/** Field codes of an entry's keys (`ENTRY_KEYS` in src/world-info-engine.js). */
const CONTENT = 104;
const ORDER = 110;
const DISPLAY_INDEX = 143;

const ALICE = { user: 'alice', session: 'tab-1' };

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    lib = await import('../src/library-engine.js');
    const { loadEngine } = await import('../engine/load.js');
    engine = loadEngine().binding;
});

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-world-info-history-test-'));
    library = await lib.LibraryEngine.open(engine, path.join(dir, 'store'));
    books = library.books;
});

afterEach(async () => {
    await library.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A book named `b` with entries 0 and 1. */
async function makeBook() {
    await books.write('b', {
        entries: {
            0: { uid: 0, key: ['dragon'], content: 'A dragon sleeps under the hill.', order: 100, displayIndex: 0 },
            1: { uid: 1, key: ['knight'], content: 'The knight keeps watch.', order: 100, displayIndex: 1 },
        },
    }, ALICE);
}

/** The entry's entity. */
async function entity(uid) {
    const at = await books.entryOf('b', uid);
    if (typeof at === 'string') throw new Error(at);
    return at.id;
}

/** The field's changes, last first: [kind, ...]. */
async function kinds(id, field) {
    return (await books.history(id, field)).changes.map((/** @type {any} */ c) => c.kind);
}

describe('world-info history', () => {
    test('each committed write is a change with who made it and when', async () => {
        await makeBook();
        const id = await entity(0);
        const before = Date.now();
        await books.editEntry('b', 0, { key: ['dragon'], content: 'A dragon sleeps under the old hill.', order: 100, displayIndex: 0 }, ALICE);
        await books.editEntry('b', 0, { key: ['dragon'], content: 'A dragon sleeps under the old hill.', order: 101, displayIndex: 0 }, { user: 'bob', session: 'none' });
        const content = await books.history(id, CONTENT);
        expect(content.changes.map((/** @type {any} */ c) => c.kind)).toEqual(['edit', 'set']);
        const [edit, set] = content.changes;
        expect(edit.user).toBe(set.user);
        expect(edit.session).not.toBeNull();
        expect(edit.session).toBe(set.session);
        expect(edit.time).toBeGreaterThanOrEqual(before);
        // A JSON value's change is kept too, by its own user; a tab with no session has none.
        const order = await books.history(id, ORDER);
        expect(order.changes).toHaveLength(2);
        expect(order.changes[0].session).toBeNull();
        expect(order.changes[0].user).not.toBe(edit.user);
        expect(await books.historyValue(id, ORDER, order.changes[1].id)).toEqual({ json: true, value: '100' });
        expect(await books.historyValue(id, CONTENT, set.id)).toEqual({ json: false, value: 'A dragon sleeps under the hill.' });
        // Nothing changed: nothing written.
        await books.editEntry('b', 0, { key: ['dragon'], content: 'A dragon sleeps under the old hill.', order: 101, displayIndex: 0 }, ALICE);
        expect(await kinds(id, CONTENT)).toEqual(['edit', 'set']);
        // The chats of the store hand ids out of the same counters.
        expect(await library.nextIds()).toBe(await library.nextIds());
        const fields = await books.historyFields(id);
        expect(fields.fields).toContain(CONTENT);
        expect(fields.fields).toContain(ORDER);
    });

    test('a deleted entry is listed and restored under its uid, or another when that is taken', async () => {
        await makeBook();
        const id = await entity(1);
        const read = async () => /** @type {any} */ (await books.read('b')).entries;
        const { jsonHash } = await import('../public/scripts/hash-utils.js');
        const was = (await read())[1];
        await books.apply('b', [{ uid: 1, base_hash: jsonHash(was), data: null }], [], ALICE);
        expect((await read())[1]).toBeUndefined();
        const deleted = /** @type {any} */ (await books.deleted('b'));
        expect(deleted.entries).toEqual([{ id, uid: '1', position: expect.any(Number), index: 1 }]);
        expect(await kinds(id, null)).toEqual(['deleted']);
        const restored = /** @type {any} */ (await books.restore('b', id, ALICE));
        expect(restored.uid).toBe('1');
        expect((await read())[1]).toEqual(was);
        expect(Object.keys(await read())).toEqual(['0', '1']);
        expect(/** @type {any} */ (await books.deleted('b')).entries).toEqual([]);
        expect(await kinds(id, null)).toEqual(['restored', 'deleted']);
        // Deleted again, its uid taken meanwhile: it comes back under the lowest free one.
        await books.apply('b', [{ uid: 1, base_hash: jsonHash(was), data: null }], [], ALICE);
        const made = /** @type {any} */ (await books.createEntry('b'));
        expect(made.entry.uid).toBe(1);
        const again = /** @type {any} */ (await books.restore('b', id, ALICE));
        expect(again.uid).toBe('2');
        expect((await read())[2]).toEqual({ ...was, uid: 2 });
        expect(await books.restore('b', id, ALICE)).toBe('no entry');
        // Its search finds it again.
        const found = /** @type {any} */ (await books.search({ name: 'b', search: 'knight', limit: 10 }));
        expect(found.entries.map((/** @type {any} */ e) => e.uid)).toEqual(['2']);
    });

    test('a revert is a new change, and the entry index follows a displayIndex set back', async () => {
        await makeBook();
        const id = await entity(0);
        await books.editEntry('b', 0, { key: ['dragon'], content: 'Gone.', order: 100, displayIndex: 5 }, ALICE);
        const [, first] = (await books.history(id, CONTENT)).changes;
        const back = /** @type {any} */ (await books.revert('b', 0, CONTENT, first.id, ALICE));
        expect(back.entry.content).toBe('A dragon sleeps under the hill.');
        const after = (await books.history(id, CONTENT)).changes;
        expect(after).toHaveLength(3);
        expect(await books.historyValue(id, CONTENT, after[0].id)).toEqual({ json: false, value: 'A dragon sleeps under the hill.' });
        const [, firstIndex] = (await books.history(id, DISPLAY_INDEX)).changes;
        await books.revert('b', 0, DISPLAY_INDEX, firstIndex.id, ALICE);
        const [e] = await library.entities([id]);
        expect(e?.entryIndex).toBe(0);
        expect(/** @type {any} */ (await books.read('b')).entries[0].displayIndex).toBe(0);
        await expect(books.revert('b', 0, CONTENT, first.id, ALICE)).rejects.toThrow();
    });

    test('forgetting leaves a marker or nothing, never the current value', async () => {
        await makeBook();
        const id = await entity(0);
        // Long enough that the edits below stay edits, and sharing nothing with the text before, so written whole.
        const long = `${'The village keeps its watch from the tower. '.repeat(8)}`;
        const write = (/** @type {string} */ content) => books.editEntry('b', 0, { key: ['dragon'], content, order: 100, displayIndex: 0 }, ALICE);
        await write(long);
        await write(`${long}One.`);
        await write(`${long}One. Two.`);
        await write(`${long}One. Two. Three.`);
        const changes = (await books.history(id, CONTENT)).changes;
        expect(changes.slice(0, 3).map((/** @type {any} */ c) => c.kind)).toEqual(['edit', 'edit', 'edit']);
        const [now, two, one] = changes;
        const rest = (await kinds(id, CONTENT)).slice(3);
        await expect(books.forget('b', id, { field: CONTENT, change: now.id }, ALICE)).rejects.toThrow();
        expect(await books.forget('b', id, { field: CONTENT, change: two.id }, ALICE)).toBe('ok');
        expect(await kinds(id, CONTENT)).toEqual(['edit', 'forgotten', 'edit', ...rest]);
        expect(await books.historyValue(id, CONTENT, now.id)).toEqual({ json: false, value: `${long}One. Two. Three.` });
        expect(await books.forget('b', id, { field: CONTENT, change: one.id, marker: false }, ALICE)).toBe('ok');
        expect(await kinds(id, CONTENT)).toEqual(['edit', 'forgotten', ...rest]);
        expect(/** @type {any} */ (await books.read('b')).entries[0].content).toBe(`${long}One. Two. Three.`);
        // Up to now, without a trace: each field's current change alone, read so from the commit on.
        expect(await books.forget('b', id, { marker: false }, ALICE)).toBe('ok');
        expect(await kinds(id, CONTENT)).toEqual(['set']);
        expect(/** @type {any} */ (await books.read('b')).entries[0].content).toBe(`${long}One. Two. Three.`);
        expect(await books.forget('b', 99n, { marker: false }, ALICE)).toBe('no entry');
    });
});
