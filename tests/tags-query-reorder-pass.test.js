import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    Database = (await import('better-sqlite3')).default;

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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-query-reorder-pass-test-'));
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
    const assign = live().prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)');
    for (const id of USED) assign.run('c.png', id);
}

/** Fills the tag query columns, leaving the sort_order fill unfinished so moves are queued. */
async function makeReady() {
    await metadataDb.fillTagNameKeysIfNeeded(directories);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
    await metadataDb.migrateTagsJsonIfNeeded(directories);
    expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(true);
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

/** TAGS in the alphabetical order, (name_key, rowid). */
const ALPHABETICAL = ['a', 'b', 'i', 'c', 'd', 'e', 'f', 'g', 'h'];
/** TAGS in the most used order, (usage_count DESC, name_key, rowid). */
const BY_ENTRIES = ['b', 'i', 'd', 'a', 'c', 'e', 'f', 'g', 'h'];
const MODE_ORDERS = { alphabetical: ALPHABETICAL, by_entries: BY_ENTRIES };

/**
 * Records a reorder pass as reorderTagDefinitions() does, at `at`.
 * @param {number} id
 * @param {'alphabetical' | 'by_entries'} mode
 * @param {unknown} [at]
 */
function record(id, mode, at = null) {
    const upsert = live().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    upsert.run('tag_reorder_pass', JSON.stringify({ id, mode, at }));
    upsert.run('tag_reorder_pass_last_id', String(id));
}

const clearRecord = () => live().prepare('DELETE FROM meta WHERE key = ?').run('tag_reorder_pass');

describe('POST /api/tags/query manual, during a reorder pass', () => {
    describe.each([['indexed path', true], ['today\'s path', false]])('%s', (_, ready) => {
        beforeEach(async () => {
            await seed();
            if (ready) await makeReady();
        });

        test.each(['alphabetical', 'by_entries'])('%s: the mode\'s order with the pending moves on top, cursors made in the pass\'s order', async (mode) => {
            expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(ready);
            record(3, mode);
            expect(await pagedIds()).toEqual(everyPageSize(MODE_ORDERS[mode]));
            const entries = /** @type {[string, 'before' | 'after', string][]} */ ([
                ['h', 'before', 'b'], ['a', 'after', 'd'], ['g', 'after', 'h'], ['e', 'before', 'b'], ['c', 'after', 'c'],
            ]);
            pend(entries);
            const want = applied(MODE_ORDERS[mode], entries);
            expect(await pagedIds()).toEqual(everyPageSize(want));
            for (const pageSize of [1, 2]) {
                for (const cursor of (await queryAll({ pageSize })).cursors) {
                    const values = cursorValues(cursor);
                    expect(values.slice(0, 3)).toEqual(['manual', 'pass', 3]);
                    expect(values).toHaveLength(mode === 'by_entries' ? 8 : 7);
                }
            }
        });

        test.each(['alphabetical', 'by_entries'])('%s: filters and ids read in the mode\'s order', async (mode) => {
            record(1, mode);
            const entries = /** @type {[string, 'before' | 'after', string][]} */ ([['c', 'after', 'f'], ['d', 'before', 'a'], ['b', 'after', 'g']]);
            pend(entries);
            const want = applied(MODE_ORDERS[mode], entries);
            expect(await pagedIds({ folders: true })).toEqual(everyPageSize(want.filter(id => FOLDERS.has(id))));
            expect(await pagedIds({ used: true })).toEqual(everyPageSize(want.filter(id => USED.has(id))));
            expect(await pagedIds({ search: 'b' })).toEqual(everyPageSize(want.filter(id => ['b', 'i'].includes(id))));
            const ids = ['a', 'b', 'd', 'g', 'missing'];
            expect(await pagedIds({ ids })).toEqual(everyPageSize(want.filter(id => ids.includes(id))));
        });

        test('a value entry leaves its tag at its own place in the mode\'s order, even after a move, and a move anchored to it uses that place', async () => {
            record(1, 'alphabetical');
            pend([['a', 'after', 'h'], ['a', 5], ['g', 'before', 'a'], ['f', 'zzz']]);
            expect(await pagedIds()).toEqual(everyPageSize(['g', 'a', 'b', 'i', 'c', 'd', 'e', 'f', 'h']));
        });

        test('once the pass is draining, the order is the stored one with what is left pending on top', async () => {
            record(1, 'alphabetical', { phase: 'drain' });
            pend([['f', 'before', 'b'], ['g', 35]]);
            expect(await pagedIds()).toEqual(everyPageSize(['a', 'f', 'b', 'c', 'g', 'd', 'e', 'i', 'h']));
            for (const cursor of (await queryAll({ pageSize: 2 })).cursors) expect(cursorValues(cursor)).toHaveLength(6);
        });

        test('a manual cursor is refused once the order it was made in is no longer the one read', async () => {
            const stored = (await query({ pageSize: 2 })).body.cursor;
            record(1, 'alphabetical');
            expect(await query({ pageSize: 2, cursor: stored })).toEqual({ status: 400, body: { error: true, reason: 'invalid-cursor' } });
            const legacy = Buffer.from(JSON.stringify(['manual', 1, '20', 1]), 'utf8').toString('base64url');
            expect((await query({ pageSize: 2, cursor: legacy })).status).toBe(400);

            const underPass1 = (await query({ pageSize: 2 })).body.cursor;
            expect((await query({ pageSize: 50, cursor: underPass1 })).body.rows.map(t => t.id)).toEqual(ALPHABETICAL.slice(2));
            record(1, 'alphabetical', { phase: 'walk', n: 3, c: 0, k: 'bramble', r: 7 });
            expect((await query({ pageSize: 50, cursor: underPass1 })).status).toBe(200);
            record(2, 'by_entries');
            expect((await query({ pageSize: 2, cursor: underPass1 })).status).toBe(400);
            const underPass2 = (await query({ pageSize: 2 })).body.cursor;
            // Pass 2's id with the other mode's form.
            const values = cursorValues(underPass2);
            const forged = Buffer.from(JSON.stringify([...values.slice(0, 3), ...values.slice(4)]), 'utf8').toString('base64url');
            expect((await query({ pageSize: 2, cursor: forged })).status).toBe(400);

            record(2, 'by_entries', { phase: 'drain' });
            expect((await query({ pageSize: 2, cursor: underPass2 })).status).toBe(400);
            const draining = (await query({ pageSize: 2 })).body.cursor;
            clearRecord();
            expect((await query({ pageSize: 50, cursor: draining })).body.rows.map(t => t.id)).toEqual(NATURAL.slice(2));
            expect((await query({ pageSize: 2, cursor: underPass2 })).status).toBe(400);
        });

        test('malformed pass cursors are refused', async () => {
            record(1, 'alphabetical');
            for (const values of [
                ['manual', 'pass', 0, 'apple', 1, 0, 0],
                ['manual', 'pass', 1.5, 'apple', 1, 0, 0],
                ['manual', 'pass', 1, 5, 1, 0, 0],
                ['manual', 'pass', 1, 'apple', 1, 2, 0],
                ['manual', 'pass', 1, 'apple', 1, 0, -1],
                ['manual', 'pass', 1, 'apple', 1, 0],
                ['alphabetical', 'pass', 1, 'apple', 1, 0, 0],
            ]) {
                const cursor = Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
                expect((await query({ pageSize: 2, cursor })).status).toBe(400);
            }
        });

        test('the alphabetical and most-used orders ignore the pass', async () => {
            const alphabetical = (await queryAll({ sort: { field: 'alphabetical' }, pageSize: 2 })).ids;
            const byEntries = (await queryAll({ sort: { field: 'by_entries' }, pageSize: 2 })).ids;
            const stored = (await query({ sort: { field: 'alphabetical' }, pageSize: 2 })).body.cursor;
            record(1, 'by_entries');
            pend([['a', 'after', 'h']]);
            expect((await queryAll({ sort: { field: 'alphabetical' }, pageSize: 2 })).ids).toEqual(alphabetical);
            expect((await queryAll({ sort: { field: 'by_entries' }, pageSize: 2 })).ids).toEqual(byEntries);
            expect((await query({ sort: { field: 'alphabetical' }, pageSize: 2, cursor: stored })).status).toBe(200);
        });
    });

    test.each(['alphabetical', 'by_entries'])('%s: once the pass has run, the order is the one shown while it was recorded', async (mode) => {
        await seed();
        await makeReady();
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        const moves = /** @type {[string, 'before' | 'after', string][]} */ ([
            ['h', 'after', 'a'], ['c', 'before', 'b'], ['a', 'after', 'i'], ['e', 'before', 'h'],
        ]);
        const [[id, side, anchor], ...rest] = moves;
        expect(await metadataDb.reorderTagDefinitions(directories, id, { [side]: anchor }, mode)).toEqual({ refused: [], queued: true });
        for (const [tag, where, to] of rest) {
            expect(await metadataDb.moveTagDefinition(directories, tag, { [where]: to })).toEqual({ refused: [], queued: true });
        }
        const shown = (await queryAll({ pageSize: 2 })).ids;
        expect(shown).toEqual(applied(MODE_ORDERS[mode], moves));
        const shownUsed = (await queryAll({ pageSize: 1, filter: { used: true } })).ids;

        await metadataDb.runTagReorderPassIfNeeded(directories);
        expect(live().prepare('SELECT value FROM meta WHERE key = ?').pluck().get('tag_reorder_pass')).toBeUndefined();
        expect((await queryAll({ pageSize: 2 })).ids).toEqual(shown);
        expect((await queryAll({ pageSize: 1, filter: { used: true } })).ids).toEqual(shownUsed);
    });
});
