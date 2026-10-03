import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rawTagRowInserter } from './util/stored-counters.js';
import { defineCharacterStoreFunctions } from '../src/character-store-schema.js';

/**
 * better-sqlite3 with the store's SQL functions registered on every connection, as the store's own connections have
 * them (character-store-schema.js).
 * @param {typeof import('better-sqlite3')} Base
 * @returns {typeof import('better-sqlite3')}
 */
function withStoreFunctions(Base) {
    return /** @type {any} */ (class extends /** @type {any} */ (Base) {
        constructor(/** @type {any[]} */ ...args) {
            super(...args);
            defineCharacterStoreFunctions({ defineFunction: (name, fn) => this.function(name, { deterministic: true }, fn) });
        }
    });
}

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    Database = withStoreFunctions((await import('better-sqlite3')).default);

    const { router } = await import('../src/endpoints/tags.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, res, next) => {
        req.user = { directories };
        next();
    });
    app.use('/api/tags', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-query-pending-test-'));
    directories = /** @type {any} */ ({
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

/** @type {import('better-sqlite3').Database | null} */
let liveDb = null;
function live() {
    liveDb ??= new Database(path.join(directories.root, 'character-metadata.sqlite'));
    return liveDb;
}

afterEach(() => {
    jest.restoreAllMocks();
    liveDb?.close();
    liveDb = null;
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/**
 * @param {object} body
 * @returns {Promise<{ status: number, body: any }>}
 */
async function query(body) {
    const response = await fetch(`${baseUrl}/api/tags/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

/**
 * Follows cursors from the first page to the end.
 * @param {object} body
 * @returns {Promise<{ ids: string[], cursors: string[] }>}
 */
async function queryAll(body) {
    const ids = [];
    const cursors = [];
    let cursor = null;
    for (let requests = 0; requests < 1000; requests++) {
        const { status, body: page } = await query({ ...body, cursor });
        expect(status).toBe(200);
        expect(page.more).toBe(false);
        ids.push(...page.rows.map(t => t.id));
        if (page.cursor === null) return { ids, cursors };
        cursors.push(page.cursor);
        cursor = page.cursor;
    }
    throw new Error('cursor does not advance');
}

/**
 * a-f and i ordered by sort_order, g and h without one. c and e are folders; b, d and i are used.
 */
const TAGS = [
    { id: 'a', name: 'Apple', sort_order: 10 },
    { id: 'b', name: 'Berry', sort_order: 20 },
    { id: 'c', name: 'Cherry', sort_order: 30, folder_type: 'OPEN' },
    { id: 'd', name: 'Date', sort_order: 40 },
    { id: 'e', name: 'Elder', sort_order: 50, folder_type: 'CLOSED' },
    { id: 'f', name: 'Fig', sort_order: 60 },
    { id: 'i', name: 'Bramble', sort_order: 70 },
    { id: 'g', name: 'Grape' },
    { id: 'h', name: 'Honeydew' },
];
const NATURAL = ['a', 'b', 'c', 'd', 'e', 'f', 'i', 'g', 'h'];
const FOLDERS = new Set(['c', 'e']);
const USED = new Set(['b', 'd', 'i']);

/** Writes TAGS and assigns the used ones. */
async function seed() {
    await metadataDb.ensureSchemaMigrated(directories);
    await metadataDb.saveTagDefinitions(directories, TAGS);
    const assign = rawTagRowInserter(live(), 'character_tags');
    for (const id of USED) assign.run('c.png', id);
}

/**
 * Records a reorder pass at its drain, the state queued entries are read in: manual reads take the stored order with
 * the queue on top, moves are queued, and running the pass only applies the queue.
 */
function recordDrainingPass() {
    const upsert = live().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    upsert.run('tag_reorder_pass', JSON.stringify({ id: 1, mode: 'alphabetical', at: { phase: 'drain' } }));
    upsert.run('tag_reorder_pass_last_id', '1');
}

/**
 * Pending entries, inserted as moveTagDefinition() queues them: [id, side, anchorId] or [id, value].
 * @param {([string, 'before' | 'after', string] | [string, unknown])[]} entries
 */
function pend(entries) {
    const anchored = live().prepare('INSERT INTO tag_pending_moves (tag_id, side, anchor_id) VALUES (?, ?, ?)');
    const valued = live().prepare('INSERT INTO tag_pending_moves (tag_id, value) VALUES (?, ?)');
    for (const entry of entries) {
        if (entry.length === 3) anchored.run(...entry);
        else valued.run(entry[0], JSON.stringify(entry[1]));
    }
}

/**
 * The order a list of anchored entries leaves, applied one by one to the whole order as the drain does, skipping
 * a tag or anchor not in `present` and a tag as its own anchor.
 * @param {string[]} order
 * @param {[string, 'before' | 'after', string][]} entries
 * @param {Set<string>} [present]
 */
function applied(order, entries, present = new Set(order)) {
    const out = order.filter(id => present.has(id));
    for (const [id, side, anchor] of entries) {
        if (id === anchor || !present.has(id) || !present.has(anchor)) continue;
        out.splice(out.indexOf(id), 1);
        out.splice(out.indexOf(anchor) + (side === 'after' ? 1 : 0), 0, id);
    }
    return out;
}

/**
 * @param {string} cursor
 * @returns {unknown[]}
 */
const cursorValues = cursor => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

const PAGE_SIZES = [1, 2, 50];

/**
 * The manual order read at each of PAGE_SIZES, following cursors.
 * @param {object} [filter]
 */
async function pagedIds(filter = {}) {
    const out = {};
    for (const pageSize of PAGE_SIZES) out[pageSize] = (await queryAll({ filter, pageSize })).ids;
    return out;
}

/** @param {string[]} ids What pagedIds() gives when every page size reads `ids`. */
const everyPageSize = ids => Object.fromEntries(PAGE_SIZES.map(pageSize => [pageSize, ids]));

describe('POST /api/tags/query manual, with many moves queued', () => {
    test('the manual order still answers, with the last move in place', async () => {
        await seed();
        recordDrainingPass();
        /** @type {[string, 'before' | 'after', string][]} */
        const entries = Array.from({ length: 5000 }, (_, i) => /** @type {[string, 'before' | 'after', string]} */ ([i % 2 ? 'a' : 'b', 'after', i % 2 ? 'b' : 'a']));
        entries.push(['a', 'after', 'f']);
        pend(entries);
        expect(await pagedIds()).toEqual(everyPageSize(applied(NATURAL, entries)));
        const byName = await query({ sort: { field: 'alphabetical' }, pageSize: 5 });
        expect(byName.status).toBe(200);
        expect(byName.body.rows.length).toBe(5);
    });
});

describe('POST /api/tags/query manual, with moves pending', () => {
    describe('indexed path', () => {
        beforeEach(async () => {
            await seed();
            recordDrainingPass();
        });

        test('with nothing pending the order is the stored one', async () => {
            expect(await pagedIds()).toEqual(everyPageSize(NATURAL));
            for (const pageSize of [1, 2]) {
                const { cursors } = await queryAll({ pageSize });
                for (const cursor of cursors) expect(cursorValues(cursor).slice(4)).toEqual([0, 0]);
            }
        });

        test('a move before and one after a stored anchor show at the anchor, and not at their own place', async () => {
            pend([['f', 'before', 'b'], ['a', 'after', 'd']]);
            expect(await pagedIds()).toEqual(everyPageSize(['f', 'b', 'c', 'd', 'a', 'e', 'i', 'g', 'h']));
        });

        test('a move next to a moved tag chains after it', async () => {
            pend([['g', 'after', 'b'], ['h', 'after', 'g']]);
            expect(await pagedIds()).toEqual(everyPageSize(['a', 'b', 'g', 'h', 'c', 'd', 'e', 'f', 'i']));
        });

        test('a later entry for the same tag wins', async () => {
            pend([['a', 'after', 'c'], ['a', 'before', 'f']]);
            expect(await pagedIds()).toEqual(everyPageSize(['b', 'c', 'd', 'e', 'a', 'f', 'i', 'g', 'h']));
        });

        test('an anchor moved later leaves the tag placed next to it at its old place', async () => {
            pend([['a', 'after', 'c'], ['c', 'after', 'f']]);
            expect(await pagedIds()).toEqual(everyPageSize(['b', 'a', 'd', 'e', 'f', 'c', 'i', 'g', 'h']));
        });

        test('entries whose tag or anchor is deleted or gone, or whose tag is its own anchor, are skipped', async () => {
            pend([['a', 'after', 'f'], ['b', 'before', 'h'], ['c', 'after', 'c'], ['missing', 'after', 'a'], ['d', 'after', 'missing']]);
            await metadataDb.deleteTagDefinition(directories, 'a', null);
            await metadataDb.deleteTagDefinition(directories, 'h', null);
            expect(await pagedIds()).toEqual(everyPageSize(['b', 'c', 'd', 'e', 'f', 'i', 'g']));
        });

        test('a value entry places the tag at that value, and a tag next to it follows it there', async () => {
            pend([['g', 35], ['h', 'before', 'g'], ['a', 45]]);
            expect(await pagedIds()).toEqual(everyPageSize(['b', 'c', 'h', 'g', 'd', 'a', 'e', 'f', 'i']));
        });

        test('a value entry places the tag by its coerced value: a numeric string at its number, one with no order among the unordered by name', async () => {
            pend([['b', '15'], ['a', 'zzz'], ['f', 'before', 'a'], ['c', { x: 1 }], ['d', null]]);
            expect(await pagedIds()).toEqual(everyPageSize(['d', 'b', 'e', 'i', 'f', 'a', 'c', 'g', 'h']));
        });

        test('a value that puts the anchor back at its place again shares the gap: the later tag is nearest', async () => {
            pend([['b', 20], ['g', 'after', 'b'], ['b', 20], ['h', 'after', 'b'], ['a', 'before', 'b']]);
            // Twice at a place other than its own.
            pend([['d', 55], ['c', 'before', 'd'], ['d', 57], ['d', 55], ['f', 'before', 'd']]);
            // What the drain writes: g 25, h 22.5, a stays at 10 (already right before b); c 52.5, f 53.75, d 55.
            expect(await pagedIds()).toEqual(everyPageSize(['a', 'b', 'h', 'g', 'e', 'c', 'f', 'd', 'i']));
        });

        test('pages of 1 and 2 cut inside gaps on both sides of an anchor, each tag once', async () => {
            const entries = /** @type {[string, 'before' | 'after', string][]} */ ([
                ['e', 'before', 'b'], ['f', 'before', 'b'], ['g', 'after', 'b'], ['h', 'after', 'b'], ['a', 'after', 'g'],
            ]);
            pend(entries);
            const want = applied(NATURAL, entries);
            expect(want).toEqual(['e', 'f', 'b', 'h', 'g', 'a', 'c', 'd', 'i']);
            expect(await pagedIds()).toEqual(everyPageSize(want));
            const sides = new Set();
            for (const pageSize of [1, 2]) {
                for (const cursor of (await queryAll({ pageSize })).cursors) sides.add(cursorValues(cursor)[4]);
            }
            expect([...sides].sort()).toEqual([-1, 0, 1]);
        });

        test('a gap next to an anchor without a sort_order sits by that anchor', async () => {
            const entries = /** @type {[string, 'before' | 'after', string][]} */ ([['a', 'after', 'g'], ['b', 'before', 'h'], ['c', 'before', 'g']]);
            pend(entries);
            expect(await pagedIds()).toEqual(everyPageSize(applied(NATURAL, entries)));
        });

        test('filters hide a moved tag that doesn\'t pass them, and show one whose anchor they hide', async () => {
            const entries = /** @type {[string, 'before' | 'after', string][]} */ ([['c', 'after', 'f'], ['d', 'before', 'a'], ['b', 'after', 'g'], ['a', 'after', 'i']]);
            pend(entries);
            const want = applied(NATURAL, entries);
            expect(want).toEqual(['d', 'e', 'f', 'c', 'i', 'a', 'g', 'b', 'h']);
            expect(await pagedIds()).toEqual(everyPageSize(want));
            expect(await pagedIds({ folders: true })).toEqual(everyPageSize(want.filter(id => FOLDERS.has(id))));
            expect(want.filter(id => FOLDERS.has(id))).toEqual(['e', 'c']);
            expect(await pagedIds({ used: true })).toEqual(everyPageSize(want.filter(id => USED.has(id))));
            expect(want.filter(id => USED.has(id))).toEqual(['d', 'i', 'b']);
            expect(await pagedIds({ search: 'b' })).toEqual(everyPageSize(['i', 'b']));
            expect(await pagedIds({ name: 'cherry' })).toEqual(everyPageSize(['c']));
        });

        test('the ids filter orders the ids by the pending moves', async () => {
            const entries = /** @type {[string, 'before' | 'after', string][]} */ ([['f', 'before', 'a'], ['g', 'after', 'f'], ['b', 'after', 'h']]);
            pend(entries);
            const ids = ['a', 'b', 'f', 'g', 'missing'];
            expect(await pagedIds({ ids })).toEqual(everyPageSize(applied(NATURAL, entries).filter(id => ids.includes(id))));
            expect(applied(NATURAL, entries).filter(id => ids.includes(id))).toEqual(['f', 'g', 'a', 'b']);
        });

        test('a 4-element manual cursor still reads, as the place after its row', async () => {
            const rowid = live().prepare('SELECT rowid FROM tags WHERE id = ?').pluck().get('b');
            const old = Buffer.from(JSON.stringify(['manual', 1, '20', rowid]), 'utf8').toString('base64url');
            const page = await query({ pageSize: 50, cursor: old });
            expect(page.status).toBe(200);
            expect(page.body.rows.map(t => t.id)).toEqual(NATURAL.slice(2));
            pend([['a', 'after', 'd'], ['h', 'before', 'b']]);
            const pending = await query({ pageSize: 50, cursor: old });
            expect(pending.body.rows.map(t => t.id)).toEqual(['c', 'd', 'a', 'e', 'f', 'i', 'g']);
        });

        test('a cursor in the gap before a row still shows that row once nothing is pending', async () => {
            pend([['h', 'before', 'c']]);
            const first = await query({ pageSize: 3 });
            expect(first.body.rows.map(t => t.id)).toEqual(['a', 'b', 'h']);
            expect(cursorValues(first.body.cursor)[4]).toBe(-1);
            live().prepare('DELETE FROM tag_pending_moves').run();
            const rest = await query({ pageSize: 50, cursor: first.body.cursor });
            expect(rest.body.rows.map(t => t.id)).toEqual(['c', 'd', 'e', 'f', 'i', 'g', 'h']);
        });

        test('the alphabetical and most-used orders ignore pending moves', async () => {
            const alphabetical = (await queryAll({ sort: { field: 'alphabetical' }, pageSize: 50 })).ids;
            const byEntries = (await queryAll({ sort: { field: 'by_entries' }, pageSize: 50 })).ids;
            pend([['a', 'after', 'h'], ['i', 5]]);
            expect((await queryAll({ sort: { field: 'alphabetical' }, pageSize: 2 })).ids).toEqual(alphabetical);
            expect((await queryAll({ sort: { field: 'by_entries' }, pageSize: 2 })).ids).toEqual(byEntries);
        });
    });

    test('once the reorder pass\'s drain applies the queued moves, the order is the one the pending moves showed', async () => {
        await seed();
        recordDrainingPass();
        const moves = /** @type {[string, 'before' | 'after', string][]} */ ([
            ['a', 'after', 'g'],
            ['h', 'before', 'c'],
            ['e', 'after', 'a'],
            ['g', 'before', 'b'],
            ['d', 'after', 'h'],
            ['b', 'after', 'i'],
            ['f', 'before', 'e'],
            ['c', 'after', 'c'],
        ]);
        for (const [id, side, anchor] of moves) {
            expect(await metadataDb.moveTagDefinition(directories, id, { [side]: anchor })).toEqual(
                id === anchor ? { refused: [{ id, reason: 'same' }], written: [] } : { refused: [], written: [], queued: true });
        }
        expect(live().prepare('SELECT COUNT(*) FROM tag_pending_moves').pluck().get()).toBe(7);
        const shown = (await queryAll({ pageSize: 2 })).ids;
        expect(shown).toEqual(applied(NATURAL, moves));
        const shownFolders = (await queryAll({ pageSize: 1, filter: { folders: true } })).ids;
        await metadataDb.runTagReorderPassIfNeeded(directories);

        expect(live().prepare('SELECT COUNT(*) FROM tag_pending_moves').pluck().get()).toBe(0);
        expect((await queryAll({ pageSize: 2 })).ids).toEqual(shown);
        expect((await queryAll({ pageSize: 1, filter: { folders: true } })).ids).toEqual(shownFolders);
    });

    test('once the reorder pass\'s drain applies queued values, the order is the one they showed', async () => {
        await seed();
        // Every tag ordered: g and h after the rest.
        for (const [id, sortOrder] of [['g', 71], ['h', 72]]) expect((await metadataDb.editTagDefinition(directories, id, { sort_order: sortOrder }))?.refused).toEqual([]);
        recordDrainingPass();
        pend([['b', '15'], ['a', 'zzz'], ['f', 'before', 'a'], ['c', { x: 1 }], ['d', null], ['h', 'after', 'd']]);
        const shown = (await queryAll({ pageSize: 2 })).ids;
        expect(shown).toEqual(['d', 'h', 'b', 'e', 'i', 'g', 'f', 'a', 'c']);
        await metadataDb.runTagReorderPassIfNeeded(directories);
        expect(live().prepare('SELECT COUNT(*) FROM tag_pending_moves').pluck().get()).toBe(0);
        expect((await queryAll({ pageSize: 2 })).ids).toEqual(shown);
    });
});
