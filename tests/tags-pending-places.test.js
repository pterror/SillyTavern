import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteTagRowRaw, insertTagRowRaw } from './util/stored-counters.js';

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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-pending-places-test-'));
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
 * The manual order, following cursors at `pageSize`.
 * @param {number} pageSize
 * @returns {Promise<string[]>}
 */
async function manualIds(pageSize) {
    const ids = [];
    let cursor = null;
    for (let requests = 0; requests < 1000; requests++) {
        const { status, body: page } = await query({ pageSize, cursor });
        expect(status).toBe(200);
        expect(page.more).toBe(false);
        ids.push(...page.rows.map(t => t.id));
        if (page.cursor === null) return ids;
        cursor = page.cursor;
    }
    throw new Error('cursor does not advance');
}

const NAMES = ['Apple', 'Berry', 'Cherry', 'Date', 'Elder', 'Fig', 'Grape', 'Honeydew', 'Kiwi', 'Lime', 'Mango', 'Nectarine'];
const IDS = NAMES.map(name => name[0].toLowerCase());

/** The first eight ordered by sort_order 10, 20, …; the rest without one. */
async function seed() {
    await metadataDb.ensureSchemaMigrated(directories);
    await metadataDb.saveTagDefinitions(directories, NAMES.map((name, n) => (n < 8 ? { id: IDS[n], name, sort_order: (n + 1) * 10 } : { id: IDS[n], name })));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await metadataDb.fillTagNameKeysIfNeeded(directories);
    await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
    await metadataDb.migrateTagsJsonIfNeeded(directories);
    expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(true);
}

/**
 * Records a reorder pass, so moves queue and manual reads walk its mode's order.
 * @param {number} id
 * @param {'alphabetical' | 'by_entries'} mode
 */
function record(id, mode) {
    const upsert = live().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    upsert.run('tag_reorder_pass', JSON.stringify({ id, mode, at: null }));
    upsert.run('tag_reorder_pass_last_id', String(id));
}

/**
 * @param {string} a
 * @param {string} b
 */
const compareNames = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * @param {string} order
 * @param {any} a
 * @param {any} b
 */
function comparePositions(order, a, b) {
    let keys = 0;
    if (order === 'manual') {
        keys = a.phase !== b.phase ? a.phase - b.phase : a.phase === 1 ? (a.s < b.s ? -1 : a.s > b.s ? 1 : 0) : compareNames(a.k, b.k);
    } else {
        keys = (order === 'by_entries' && a.c !== b.c) ? b.c - a.c : compareNames(a.k, b.k);
    }
    return keys || a.r - b.r || (a.g ?? 0) - (b.g ?? 0) || (a.i ?? 0) - (b.i ?? 0);
}

/**
 * The manual order as queries read it before tag_pending_places existed: tag_pending_moves replayed in arrival
 * order over the rows as they are now (the replay that piece 8c of the tags plan replaces), every unmarked tag at
 * its place.
 * @param {{ mode: string } | null} pass
 * @returns {string[]}
 */
function replayedOrder(pass) {
    const order = pass?.mode ?? 'manual';
    const rows = new Map([...live().prepare(`SELECT rowid AS r, id, data, name_key, sort_order, usage_count,
        EXISTS (SELECT 1 FROM tag_deletions WHERE tag_id = tags.id) AS marked FROM tags`).iterate()].map(row => [row.id, row]));
    const position = row => ({ phase: order === 'manual' && row.sort_order === null ? 2 : 1, s: row.sort_order, k: row.name_key, c: row.usage_count, r: row.r });
    const valuePosition = (row, value) => ({ phase: value === null ? 2 : 1, s: value, k: row.name_key, c: row.usage_count, r: row.r });
    const usable = row => row !== undefined && !row.marked;
    const gapsByAnchor = new Map();
    const placed = new Map();
    const values = new Map();
    const unplace = id => {
        const gap = placed.get(id);
        if (!gap) return;
        gap.items.splice(gap.items.indexOf(id), 1);
        placed.delete(id);
    };
    for (const { tag_id: id, side, anchor_id: anchorId, value } of live().prepare('SELECT tag_id, side, anchor_id, value FROM tag_pending_moves ORDER BY seq').iterate()) {
        const row = rows.get(id);
        if (!usable(row)) continue;
        if (side === null) {
            unplace(id);
            if (pass === null) values.set(id, metadataDb.tagDerivedColumns({ sort_order: JSON.parse(value) }).sortOrder);
            continue;
        }
        const anchor = rows.get(anchorId);
        if (id === anchorId || !usable(anchor)) continue;
        unplace(id);
        values.delete(id);
        const anchorGap = placed.get(anchorId);
        if (anchorGap) {
            anchorGap.items.splice(anchorGap.items.indexOf(anchorId) + (side === 'after' ? 1 : 0), 0, id);
            placed.set(id, anchorGap);
            continue;
        }
        const anchorValue = values.get(anchorId);
        const base = anchorValue === undefined ? position(anchor) : valuePosition(anchor, anchorValue);
        const gaps = gapsByAnchor.get(anchorId) ?? [];
        gapsByAnchor.set(anchorId, gaps);
        let gap = gaps.find(g => g.side === side && comparePositions(order, g.base, base) === 0);
        if (!gap) {
            gap = { base, side, items: [] };
            gaps.push(gap);
        }
        if (side === 'before') gap.items.push(id);
        else gap.items.unshift(id);
        placed.set(id, gap);
    }
    const keys = new Map();
    for (const [id, value] of values) keys.set(id, valuePosition(rows.get(id), value));
    for (const gaps of gapsByAnchor.values()) {
        for (const { base, side, items } of gaps) items.forEach((id, i) => keys.set(id, { ...base, g: side === 'before' ? -1 : 1, i }));
    }
    return [...rows.values()].filter(row => !row.marked)
        .map(row => ({ id: row.id, place: keys.get(row.id) ?? position(row) }))
        .sort((a, b) => comparePositions(order, a.place, b.place))
        .map(({ id }) => id);
}

/** What a drain step changes: the entries left and every tag's sort_order and the pass record. */
const drainState = () => [
    [...live().prepare('SELECT seq FROM tag_pending_moves ORDER BY seq').pluck().iterate()].join(','),
    [...live().prepare('SELECT id || \':\' || IFNULL(sort_order, \'-\') FROM tags ORDER BY id').pluck().iterate()].join(','),
    live().prepare('SELECT value FROM meta WHERE key = ?').pluck().get('tag_reorder_pass') ?? '',
].join('|');

/**
 * The pass manual reads follow now: none once the recorded pass is draining or gone.
 * @param {{ mode: string } | null} pass
 */
function drainPass(pass) {
    const record = live().prepare('SELECT value FROM meta WHERE key = ?').pluck().get('tag_reorder_pass');
    if (pass === null || record === undefined) return null;
    return JSON.parse(record).at?.phase === 'drain' ? null : pass;
}

/**
 * A seeded random source (mulberry32).
 * @param {number} seed
 */
function random(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const VALUES = [5, 15, 15.5, '25', '30', null, 'zzz', 40, 45, 1000, -3];

/**
 * One random change: a move (or one refused as the tag's own anchor), a queued sort_order value (stored order only),
 * a rename, or a tag put on or taken off a character.
 * @param {() => number} next
 * @param {boolean} values Whether to queue values.
 * @param {number} step
 */
async function randomChange(next, values, step) {
    const pick = list => list[Math.floor(next() * list.length)];
    const roll = next();
    if (roll < 0.6) {
        const id = pick(IDS);
        const anchor = next() < 0.05 ? id : pick(IDS);
        await metadataDb.moveTagDefinition(directories, id, { [next() < 0.5 ? 'before' : 'after']: anchor });
    } else if (roll < 0.7 && values) {
        expect((await metadataDb.editTagDefinition(directories, pick(IDS), { sort_order: pick(VALUES) }))?.refused ?? []).toEqual([]);
    } else if (roll < 0.85) {
        const id = pick(IDS);
        expect((await metadataDb.editTagDefinition(directories, id, { name: `${pick(['A', 'b', 'Z', 'm'])}${id}${step}` }))?.refused ?? []).toEqual([]);
    } else {
        const tagId = pick(IDS);
        const characterId = pick(['c1.png', 'c2.png', 'c3.png']);
        const has = live().prepare('SELECT 1 FROM character_tags WHERE character_id = ? AND tag_id = ?').get(characterId, tagId);
        if (has) deleteTagRowRaw(live(), 'character_tags', characterId, tagId);
        else insertTagRowRaw(live(), 'character_tags', characterId, tagId);
    }
}

describe('tag_pending_places gives the order the queue replay gave', () => {
    describe.each([
        ['the stored order (sort_order fill unfinished)', null],
        ['an alphabetical reorder pass', 'alphabetical'],
        ['a most-used reorder pass', 'by_entries'],
    ])('%s', (_, mode) => {
        test.each([1, 2, 3, 4, 5, 6])('random moves, values, renames and usage changes, seed %i', async (seedNumber) => {
            await seed();
            if (mode !== null) {
                // A pass runs once the sort_order fill has finished.
                await metadataDb.fillTagSortOrdersIfNeeded(directories);
                record(1, /** @type {'alphabetical' | 'by_entries'} */ (mode));
            }
            const pass = mode === null ? null : { mode };
            const next = random(seedNumber * 7919 + (mode?.length ?? 0));
            for (let step = 0; step < 40; step++) {
                await randomChange(next, mode === null, step);
                const want = replayedOrder(pass);
                // Every 8th step also in pages of 1 and 2, which cut inside gaps.
                for (const pageSize of step % 8 === 7 ? [50, 1, 2] : [50]) expect(await manualIds(pageSize)).toEqual(want);
            }
            expect(live().prepare('SELECT COUNT(*) FROM tag_pending_moves').pluck().get()).toBeGreaterThan(0);

            // While the drain applies the entries one at a time, each read between two of them is the replay of those left.
            let done = false;
            const drain = (mode === null ? metadataDb.fillTagSortOrdersIfNeeded(directories) : metadataDb.runTagReorderPassIfNeeded(directories)).then(() => { done = true; });
            let checked = 0;
            while (!done) {
                const before = drainState();
                const want = replayedOrder(drainPass(pass));
                const ids = await manualIds(50);
                if (drainState() !== before) continue;
                expect(ids).toEqual(want);
                checked++;
            }
            await drain;
            expect(checked).toBeGreaterThan(0);
            expect(live().prepare('SELECT COUNT(*) FROM tag_pending_moves').pluck().get()).toBe(0);
            expect(live().prepare('SELECT COUNT(*) FROM tag_pending_places').pluck().get()).toBe(0);
        });
    });
});

describe('tag_pending_places, when a tag the queue names is deleted', () => {
    test('A after B, C after A, B deleted: A and C stay where B was until the queue drains, then take the order the drain leaves', async () => {
        await seed();
        // a b c d e f g h ordered, k l m n not. A = e, B = b, C = h.
        expect(await metadataDb.moveTagDefinition(directories, 'e', { after: 'b' })).toEqual({ refused: [], written: [], queued: true });
        expect(await metadataDb.moveTagDefinition(directories, 'h', { after: 'e' })).toEqual({ refused: [], written: [], queued: true });
        const before = ['a', 'b', 'e', 'h', 'c', 'd', 'f', 'g', 'k', 'l', 'm', 'n'];
        expect(await manualIds(50)).toEqual(before);
        expect(replayedOrder(null)).toEqual(before);

        await metadataDb.deleteTagDefinition(directories, 'b', null);
        const whereBWas = ['a', 'e', 'h', 'c', 'd', 'f', 'g', 'k', 'l', 'm', 'n'];
        // The replay skipped both entries' effects on B: e at its own place, h right after it.
        expect(replayedOrder(null)).toEqual(['a', 'c', 'd', 'e', 'h', 'f', 'g', 'k', 'l', 'm', 'n']);
        expect(await manualIds(50)).toEqual(whereBWas);
        for (const pageSize of [1, 2]) expect(await manualIds(pageSize)).toEqual(whereBWas);

        // B's row removed: the gap stays at the place B had.
        await metadataDb.finishDeletedTags(directories);
        expect(live().prepare('SELECT COUNT(*) FROM tags WHERE id = ?').pluck().get('b')).toBe(0);
        expect(await manualIds(50)).toEqual(whereBWas);
        for (const pageSize of [1, 2]) expect(await manualIds(pageSize)).toEqual(whereBWas);

        // The drain drops "e after b" (b is gone) and applies "h after e": the jump.
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(live().prepare('SELECT COUNT(*) FROM tag_pending_places').pluck().get()).toBe(0);
        expect(await manualIds(50)).toEqual(['a', 'c', 'd', 'e', 'h', 'f', 'g', 'k', 'l', 'm', 'n']);
    });

    test('under a reorder pass the gap stays at B\'s last place in the mode\'s order', async () => {
        await seed();
        record(1, 'alphabetical');
        await metadataDb.moveTagDefinition(directories, 'e', { after: 'b' });
        await metadataDb.moveTagDefinition(directories, 'h', { after: 'e' });
        // Alphabetical: apple berry cherry date elder fig grape honeydew kiwi lime mango nectarine.
        const whereBWas = ['a', 'e', 'h', 'c', 'd', 'f', 'g', 'k', 'l', 'm', 'n'];
        await metadataDb.deleteTagDefinition(directories, 'b', null);
        expect(await manualIds(50)).toEqual(whereBWas);
        await metadataDb.finishDeletedTags(directories);
        expect(await manualIds(50)).toEqual(whereBWas);
        for (const pageSize of [1, 2]) expect(await manualIds(pageSize)).toEqual(whereBWas);
    });
});

describe('tag_pending_places, its upkeep', () => {
    test('entries queued without it (by an older version) are taken in by the next read', async () => {
        await seed();
        const queue = live().prepare('INSERT INTO tag_pending_moves (tag_id, side, anchor_id) VALUES (?, ?, ?)');
        queue.run('k', 'after', 'a');
        queue.run('l', 'after', 'k');
        expect(live().prepare('SELECT COUNT(*) FROM tag_pending_places').pluck().get()).toBe(0);
        const want = ['a', 'k', 'l', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'm', 'n'];
        expect(replayedOrder(null)).toEqual(want);
        expect(await manualIds(50)).toEqual(want);
        expect(live().prepare('SELECT COUNT(*) FROM tag_pending_places').pluck().get()).toBe(2);
        // A move queued now lands after them, as the replay puts it.
        await metadataDb.moveTagDefinition(directories, 'm', { after: 'a' });
        expect(await manualIds(50)).toEqual(replayedOrder(null));
    });

    test('many moves into one spot keep their order: the gap is renumbered once halving runs out', async () => {
        await seed();
        await metadataDb.moveTagDefinition(directories, 'k', { after: 'a' });
        await metadataDb.moveTagDefinition(directories, 'l', { after: 'k' });
        // m and n by turns right before l: each lands between l and the other, halving the room left before l.
        for (let n = 0; n < 80; n++) {
            await metadataDb.moveTagDefinition(directories, n % 2 ? 'n' : 'm', { before: 'l' });
        }
        expect(live().prepare('SELECT MAX(i) FROM tag_pending_places WHERE anchor_id = ?').pluck().get('a')).toBeGreaterThan(2);
        expect(await manualIds(50)).toEqual(replayedOrder(null));
        for (const pageSize of [1, 2]) expect(await manualIds(pageSize)).toEqual(replayedOrder(null));
    });

    test('a rename moves a value\'s place among the tags without an order', async () => {
        await seed();
        expect((await metadataDb.editTagDefinition(directories, 'a', { sort_order: 'zzz' }))?.refused).toEqual([]);
        await metadataDb.moveTagDefinition(directories, 'b', { after: 'a' });
        const read = async () => {
            expect(await manualIds(50)).toEqual(replayedOrder(null));
            return (await manualIds(50)).filter(id => ['a', 'b', 'k', 'l', 'm', 'n'].includes(id));
        };
        expect(await read()).toEqual(['a', 'b', 'k', 'l', 'm', 'n']);
        await metadataDb.editTagDefinition(directories, 'a', { name: 'Lychee' });
        expect(await read()).toEqual(['k', 'l', 'a', 'b', 'm', 'n']);
    });
});
