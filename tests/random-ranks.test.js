import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {typeof import('../src/random-order.js')} */
let randomOrder;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    randomOrder = await import('../src/random-order.js');
    Database = (await import('better-sqlite3')).default;
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-random-ranks-test-'));
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
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

const dbPath = () => path.join(directories.root, 'character-metadata.sqlite');
const SEP = '\u001f';

/** @param {(db: import('better-sqlite3').Database) => void} work */
function withDb(work) {
    metadataDb.disposeMetadataStores();
    const db = new Database(dbPath());
    try {
        work(db);
    } finally {
        db.close();
    }
}

/** @param {string} id @param {string} name */
async function addCharacter(id, name) {
    const cardJson = JSON.stringify({ name, data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
    await metadataDb.upsertCharacterFromWrite(directories, id, cardJson);
}

/** @param {string} id @param {string} name */
async function addGroup(id, name) {
    const group = { id, name, members: [], chats: [], fav: false };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, name, { fav: false, group });
}

/**
 * The spaces every entity should be in, from the entity and tag tables, against what random_ranks holds; and every
 * space's ranks dense.
 */
function checkRanks() {
    const db = new Database(dbPath(), { readonly: true });
    try {
        const want = new Set();
        for (const [code, table, tagTable, column, counts] of [['c', 'characters', 'character_tags', 'character_id', () => true], ['g', 'groups', 'group_tags', 'group_id', id => !id.endsWith('.png')]]) {
            for (const e of db.prepare(`SELECT id, fav FROM ${table}`).all()) {
                const fav = e.fav ? 1 : 0;
                want.add(`${code}|${e.id}|a`);
                want.add(`${code}|${e.id}|f${fav}`);
                for (const t of db.prepare(`SELECT tag_id FROM ${tagTable} WHERE ${column} = ?`).all(e.id)) {
                    if (!counts(e.id)) continue;
                    want.add(`${code}|${e.id}|t${SEP}${t.tag_id}`);
                    want.add(`${code}|${e.id}|t${SEP}${t.tag_id}${SEP}f${fav}`);
                }
            }
        }
        const rows = db.prepare('SELECT space, rank, kind, entity_id FROM random_ranks').all();
        const have = new Set(rows.map(r => `${r.kind}|${r.entity_id}|${r.space}`));
        expect([...have].sort()).toEqual([...want].sort());
        /** @type {Map<string, number[]>} */
        const bySpace = new Map();
        for (const r of rows) {
            if (!bySpace.has(r.space)) bySpace.set(r.space, []);
            bySpace.get(r.space).push(r.rank);
        }
        for (const [space, ranks] of bySpace) {
            ranks.sort((a, b) => a - b);
            expect({ space, ranks }).toEqual({ space, ranks: ranks.map((_, i) => i) });
        }
    } finally {
        db.close();
    }
}

async function seed() {
    for (let i = 0; i < 12; i++) await addCharacter(`c${String(i).padStart(2, '0')}.png`, `Char ${i}`);
    for (let i = 0; i < 4; i++) await addGroup(`g${i}`, `Group ${i}`);
    withDb(db => {
        db.prepare('UPDATE characters SET fav = 1 WHERE id IN (\'c01.png\', \'c03.png\', \'c05.png\')').run();
        db.prepare('UPDATE groups SET fav = 1 WHERE id = \'g1\'').run();
        for (const [character, tag] of [['c00.png', 't1'], ['c01.png', 't1'], ['c02.png', 't2'], ['c03.png', 't1'], ['c03.png', 't2'], ['c07.png', 't3']]) {
            db.prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)').run(character, tag);
        }
        db.prepare('INSERT INTO group_tags (group_id, tag_id) VALUES (\'g0\', \'t1\'), (\'g1\', \'t1\')').run();
        // As if these rows were older than the rank triggers: the fill has to number them.
        db.prepare('DELETE FROM random_ranks').run();
        db.prepare('DELETE FROM meta WHERE key LIKE \'random_ranks_%\'').run();
    });
}

describe('random order numbering (search plan step 7a, 7b)', () => {
    test('the fill numbers every entity in every space it belongs to, densely, and resumes', async () => {
        await seed();
        const first = await metadataDb.fillRandomRanksIfNeeded(directories);
        expect(first.rowsChanged).toBeGreaterThan(0);
        checkRanks();
        const again = await metadataDb.fillRandomRanksIfNeeded(directories);
        expect(again).toEqual({ batches: 0, rowsChanged: 0 });
    });

    test('adds, deletes, fav flips, tag assigns, unassigns and moves keep every space dense and right', async () => {
        expect.hasAssertions();
        await seed();
        await metadataDb.fillRandomRanksIfNeeded(directories);
        await addCharacter('new1.png', 'New 1');
        await addGroup('g9', 'Group 9');
        checkRanks();
        withDb(db => {
            db.prepare('UPDATE characters SET fav = 1 WHERE id = \'c00.png\'').run();
            db.prepare('UPDATE characters SET fav = 0 WHERE id = \'c03.png\'').run();
            db.prepare('UPDATE groups SET fav = 1 WHERE id = \'g0\'').run();
            db.prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (\'c09.png\', \'t1\'), (\'new1.png\', \'t2\')').run();
            db.prepare('DELETE FROM character_tags WHERE character_id = \'c01.png\' AND tag_id = \'t1\'').run();
            db.prepare('UPDATE character_tags SET tag_id = \'t4\' WHERE character_id = \'c02.png\' AND tag_id = \'t2\'').run();
            db.prepare('DELETE FROM characters WHERE id IN (\'c00.png\', \'c11.png\', \'c05.png\')').run();
            db.prepare('DELETE FROM groups WHERE id = \'g1\'').run();
            db.prepare('UPDATE characters SET fav = fav WHERE id = \'c04.png\'').run();
        });
        checkRanks();
        // Removing the last member of a space, and the space emptying.
        withDb(db => {
            db.prepare('DELETE FROM character_tags WHERE tag_id = \'t3\'').run();
            for (const row of db.prepare('SELECT id FROM characters ORDER BY id DESC').all()) {
                db.prepare('DELETE FROM characters WHERE id = ?').run(row.id);
            }
        });
        checkRanks();
    });
});

describe('random order permutation (search plan step 7c, 7e)', () => {
    const SIZES = [1, 2, 3, 4, 5, 7, 8, 9, 63, 64, 65, 1000, 4096, 4097];
    const SEEDS = [0, 1, 7, 42, 99991, 123456789, -3];

    test('every size and seed maps positions to ranks one to one, and the inverse undoes it', () => {
        for (const n of SIZES) {
            for (const seed of SEEDS) {
                const key = randomOrder.orderKey(seed, 'a');
                const ranks = new Set();
                for (let i = 0; i < n; i++) {
                    const r = randomOrder.permute(i, n, key);
                    ranks.add(r);
                    expect(r >= 0 && r < n).toBe(true);
                    expect(randomOrder.unpermute(r, n, key)).toBe(i);
                }
                expect({ n, seed, distinct: ranks.size }).toEqual({ n, seed, distinct: n });
            }
        }
    });

    test('orders under different seeds look independent', () => {
        const n = 2000;
        const seeds = Array.from({ length: 20 }, (_, i) => 1000 + i * 7919);
        const orders = seeds.map(seed => {
            const key = randomOrder.orderKey(seed, 'a');
            return Array.from({ length: n }, (_, i) => randomOrder.permute(i, n, key));
        });
        // Spearman rank correlation between consecutive seeds' orders: its sd under independence is 1/sqrt(n - 1).
        const sd = 1 / Math.sqrt(n - 1);
        for (let s = 0; s + 1 < orders.length; s++) {
            const posA = new Array(n), posB = new Array(n);
            orders[s].forEach((r, i) => { posA[r] = i; });
            orders[s + 1].forEach((r, i) => { posB[r] = i; });
            let d2 = 0;
            for (let r = 0; r < n; r++) d2 += (posA[r] - posB[r]) ** 2;
            const rho = 1 - (6 * d2) / (n * (n * n - 1));
            expect(Math.abs(rho)).toBeLessThan(4 * sd);
        }
        // Pairs adjacent in both of two orders: about 2 expected (each order has n - 1 adjacent pairs, 2/n chance each).
        let shared = 0;
        for (let s = 0; s + 1 < orders.length; s++) {
            const adjacent = new Set();
            for (let i = 0; i + 1 < n; i++) {
                const [a, b] = [orders[s][i], orders[s][i + 1]].sort((x, y) => x - y);
                adjacent.add(`${a},${b}`);
            }
            for (let i = 0; i + 1 < n; i++) {
                const [a, b] = [orders[s + 1][i], orders[s + 1][i + 1]].sort((x, y) => x - y);
                if (adjacent.has(`${a},${b}`)) shared++;
            }
        }
        const pairs = orders.length - 1;
        const expected = pairs * 2 * (n - 1) / n;
        expect(Math.abs(shared - expected)).toBeLessThan(4 * Math.sqrt(expected) + 1);
        // One rank's position across seeds spreads over the whole range: its mean is near (n - 1) / 2.
        for (const rank of [0, 1, n - 1, 777]) {
            const positions = orders.map(order => order.indexOf(rank));
            const mean = positions.reduce((a, b) => a + b, 0) / positions.length;
            const sdMean = Math.sqrt((n * n - 1) / 12) / Math.sqrt(positions.length);
            expect(Math.abs(mean - (n - 1) / 2)).toBeLessThan(4 * sdMean);
        }
    });
});

describe('random order pages (search plan step 7c)', () => {
    /** The shapes /query sends, each with the entities it matches read through the name sort. */
    const SHAPES = [
        { name: 'no filter', params: {} },
        { name: 'favourites', params: { fav: true } },
        { name: 'not favourites', params: { fav: false } },
        { name: 'one tag', params: { tags: { include: ['t1'], mode: 'and' } } },
        { name: 'one tag, favourites', params: { tags: { include: ['t1'], mode: 'and' }, fav: true } },
        { name: 'two tags', params: { tags: { include: ['t1', 't2'], mode: 'and' } } },
        { name: 'either tag', params: { tags: { include: ['t1', 't2'], mode: 'or' } } },
        { name: 'an excluded tag', params: { tags: { include: [], exclude: ['t1'], mode: 'and' } } },
        { name: 'a tag and an excluded tag', params: { tags: { include: ['t1'], exclude: ['t2'], mode: 'and' } } },
        { name: 'excluded ids', params: { excludeIds: ['c02.png', 'g0'] } },
        { name: 'an id list', params: { ids: ['c01.png', 'c04.png', 'g1', 'c09.png', 'nope.png'] } },
    ];

    /** @param {object} params */
    async function matching(params, groupsOnly = false) {
        const result = await metadataDb.queryEntities(directories, { ...params, groupsOnly, sortField: 'name', sortOrder: 'asc', offset: 0, limit: 1000, wantTotal: false });
        return result.rows.map(r => `${r.type}:${r.id}`);
    }

    /** Every page followed by its cursor. */
    async function followed(params, { seed, sortOrder, limit, groupsOnly = false }) {
        const out = [];
        let cursor;
        for (let i = 0; i < 100; i++) {
            const page = await metadataDb.queryEntities(directories, { ...params, groupsOnly, sortField: 'random', seed, sortOrder, offset: 0, limit, wantTotal: false, cursor, handle: 'test' });
            out.push(...page.rows.map(r => `${r.type}:${r.id}`));
            cursor = page.cursor;
            if (!cursor) break;
        }
        return out;
    }

    beforeEach(async () => {
        await seed();
        await metadataDb.fillRandomRanksIfNeeded(directories);
    });

    test('every shape, direction and seed lists each match exactly once, by cursor and by offset alike', async () => {
        for (const shape of SHAPES) {
            const want = (await matching(shape.params)).sort();
            for (const seed of [1, 77, 4242]) {
                for (const sortOrder of ['asc', 'desc']) {
                    const whole = await metadataDb.queryEntities(directories, { ...shape.params, sortField: 'random', seed, sortOrder, offset: 0, limit: 1000, wantTotal: false, handle: 'test' });
                    const order = whole.rows.map(r => `${r.type}:${r.id}`);
                    expect({ shape: shape.name, seed, sortOrder, set: [...order].sort() }).toEqual({ shape: shape.name, seed, sortOrder, set: want });
                    expect({ shape: shape.name, seed, sortOrder, rows: await followed(shape.params, { seed, sortOrder, limit: 3 }) }).toEqual({ shape: shape.name, seed, sortOrder, rows: order });
                    const byOffset = [];
                    for (let offset = 0; offset < order.length; offset += 4) {
                        const page = await metadataDb.queryEntities(directories, { ...shape.params, sortField: 'random', seed, sortOrder, offset, limit: 4, wantTotal: false, handle: 'test' });
                        byOffset.push(...page.rows.map(r => `${r.type}:${r.id}`));
                    }
                    expect({ shape: shape.name, seed, sortOrder, rows: byOffset }).toEqual({ shape: shape.name, seed, sortOrder, rows: order });
                }
            }
        }
    });

    test('descending is the ascending order reversed, and another seed gives another order', async () => {
        const asc = await followed({}, { seed: 5, sortOrder: 'asc', limit: 100 });
        const desc = await followed({}, { seed: 5, sortOrder: 'desc', limit: 100 });
        expect(desc).toEqual([...asc].reverse());
        const other = await followed({}, { seed: 6, sortOrder: 'asc', limit: 100 });
        expect([...other].sort()).toEqual([...asc].sort());
        expect(other).not.toEqual(asc);
    });

    test('groups only, and characters only, list just their kind', async () => {
        const groups = await followed({}, { seed: 9, sortOrder: 'asc', limit: 2, groupsOnly: true });
        expect(groups.sort()).toEqual((await matching({}, true)).sort());
        const characters = [];
        let cursor;
        for (let i = 0; i < 100; i++) {
            const page = await metadataDb.queryCharacters(directories, { sortField: 'random', seed: 9, sortOrder: 'asc', offset: 0, limit: 2, wantTotal: false, cursor });
            characters.push(...page.rows.map(r => r.avatar));
            cursor = page.cursor;
            if (!cursor) break;
        }
        expect(characters.sort()).toEqual((await matching({})).filter(e => e.startsWith('character:')).map(e => e.slice('character:'.length)).sort());
    });

    test('past the work cap, a walked page answers `more` and a cursor, and following them lists everything once', async () => {
        metadataDb._setRandomPageWalkForTests({ cap: 1, window: 1 });
        try {
            const params = { tags: { include: [], exclude: ['t1'], mode: 'and' } };
            const want = (await matching(params)).sort();
            const out = [];
            let cursor;
            let sawMore = false;
            for (let i = 0; i < 200; i++) {
                const page = await metadataDb.queryEntities(directories, { ...params, sortField: 'random', seed: 3, sortOrder: 'asc', offset: 0, limit: 100, wantTotal: false, cursor, handle: 'test' });
                if (page.more) sawMore = true;
                out.push(...page.rows.map(r => `${r.type}:${r.id}`));
                cursor = page.cursor;
                if (!cursor) break;
            }
            expect(sawMore).toBe(true);
            expect(out.sort()).toEqual(want);
        } finally {
            metadataDb._setRandomPageWalkForTests(null);
        }
    });

    test('a page reads the page, not the library: no read of every id', async () => {
        const db = new Database(dbPath(), { readonly: true });
        try {
            const plan = db.prepare('EXPLAIN QUERY PLAN SELECT rank, kind, entity_id FROM random_ranks WHERE space = ? AND rank IN (SELECT value FROM json_each(?))').all('a', '[1,2]').map(r => r.detail).join(' | ');
            expect(plan).toMatch(/SEARCH random_ranks USING PRIMARY KEY/);
        } finally {
            db.close();
        }
    });
});
