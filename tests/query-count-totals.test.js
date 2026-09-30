import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// POST /api/characters/query's total read from the stored counters (entity_counts / entity_tag_counts) once their
// fill is done, for the shapes they answer: no filter, fav alone, one included tag, one excluded tag (each ± fav).
// Every other shape, and any shape before the fill is done, keeps the COUNT(*) statement. Each counted shape is
// compared against that statement's answer on the same data.

/** @type {import('express').Router} */
let router;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/** @type {string[]} The SQL of every read made through the store's handles. */
let readSql = [];
/** @type {{ sql: string, params: any, rows: number, ids: string[] }[]} Every iterate() through the store's handles, with what it yielded. */
let iterated = [];

/** @param {any} handle */
function recordingHandle(handle) {
    const wrapped = { ...handle };
    for (const method of ['get', 'all']) {
        wrapped[method] = (sql, params) => {
            readSql.push(sql);
            return handle[method](sql, params);
        };
    }
    wrapped.iterate = function* (sql, params) {
        readSql.push(sql);
        const record = { sql, params, rows: 0, ids: [] };
        iterated.push(record);
        for (const row of handle.iterate(sql, params)) {
            record.rows++;
            if (row && typeof row === 'object' && 'id' in row) record.ids.push(row.id);
            yield row;
        }
    };
    return wrapped;
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    const sqliteEngine = await import('../src/endpoints/sqlite-engine.js');
    const engine = await sqliteEngine.getSqliteEngine();
    const openDatabase = engine.openDatabase;
    engine.openDatabase = (dbPath, options) => recordingHandle(openDatabase(dbPath, options));

    ({ router } = await import('../src/endpoints/characters.js'));
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    Database = (await import('better-sqlite3')).default;

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-query-count-totals-test-'));
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
    readSql = [];
    iterated = [];
});

afterEach(async () => {
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @template T @param {(db: import('better-sqlite3').Database) => T} fn @returns {T} */
function withRawDb(fn) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** @param {string} name @param {boolean} fav */
function cardFor(name, fav) {
    return {
        name, fav, spec: 'chara_card_v2', spec_version: '2.0',
        data: { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav, world: '' } },
    };
}

async function seedCharacter(id, fav = false) {
    await metadataDb.upsertCharacterFromWrite(directories, id, JSON.stringify(cardFor(id.replace(/\.png$/, ''), fav)));
}

async function seedCharacterWithFile(id, name) {
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const card = cardFor(name, false);
    await fs.promises.writeFile(path.join(directories.characters, id), cardParser.write(baseImage, JSON.stringify(card)));
    await metadataDb.upsertCharacterFromWrite(directories, id, JSON.stringify(card));
}

async function seedGroup(id, fav = false) {
    const group = { id, name: id, members: [], chats: [], fav };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, id, { fav, group });
}

/** @param {string[]} ids */
async function saveTags(ids) {
    expect(await metadataDb.saveTagDefinitions(directories, ids.map(id => ({ id, name: `name-${id}` })))).toBe('ok');
}

async function assign(id, tagId) {
    expect(await metadataDb.assignEntityTag(directories, id, tagId)).toBe('ok');
}

/**
 * Characters: a (fav; t1, t2), b (t1), c (fav), d (t2), e (t1), w (world 'lore'; t1).
 * Groups: ga (fav; t1), gb (t2), gc.
 */
async function seedLibrary() {
    await saveTags(['t1', 't2', 't3']);
    await seedCharacter('a.png', true);
    await seedCharacter('b.png');
    await seedCharacter('c.png', true);
    await seedCharacter('d.png');
    await seedCharacter('e.png');
    const lore = cardFor('w', false);
    lore.data.extensions.world = 'lore';
    await metadataDb.upsertCharacterFromWrite(directories, 'w.png', JSON.stringify(lore));
    await seedGroup('ga', true);
    await seedGroup('gb');
    await seedGroup('gc');
    for (const id of ['a.png', 'b.png', 'e.png', 'w.png', 'ga']) await assign(id, 't1');
    for (const id of ['a.png', 'd.png', 'gb']) await assign(id, 't2');
}

async function fill() {
    await metadataDb.fillEntityCountsIfNeeded(directories);
    withRawDb(db => expect(Array.from(db.prepare('SELECT kind, done FROM entity_count_fill ORDER BY kind').iterate())).toEqual([
        { kind: 'character', done: 1 }, { kind: 'group', done: 1 },
    ]));
}

async function postJson(body) {
    return fetch(`${baseUrl}/api/characters/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** The JSON total of one request, and whether the COUNT(*) statement ran for it. */
async function jsonTotal(filter) {
    readSql = [];
    iterated = [];
    const response = await postJson({ filter, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 2, want: ['rows', 'total'] });
    expect(response.status).toBe(200);
    const body = await response.json();
    return { total: body.total, counted: countRan() };
}

/** The binary hash-mode header of one request: its total, whether it's flagged approximate, and whether COUNT(*) ran. */
async function binaryTotal(filter) {
    readSql = [];
    iterated = [];
    const response = await postJson({ filter, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 2, want: ['hashes', 'total'] });
    expect(response.status).toBe(200);
    const view = new DataView(await response.arrayBuffer());
    const flags = view.getUint8(0);
    expect(flags & 0b01).toBe(0b01);
    return { total: view.getFloat64(1 + 1 + 8, true), approx: (flags & 0b10) !== 0, counted: countRan() };
}

function countRan() {
    return readSql.some(sql => sql.includes('COUNT(*) as total'));
}

const COUNTED_TAG_SHAPES = [
    ['no tag filter', undefined],
    ['one included tag', { include: ['t1'] }],
    ['one included tag, or mode', { include: ['t2'], mode: 'or' }],
    ['one excluded tag', { exclude: ['t1'] }],
    ['empty include and exclude lists', { include: [], exclude: [''] }],
];
const FAV_VALUES = [undefined, true, false];
const COUNTED_CASES = COUNTED_TAG_SHAPES.flatMap(([label, tags]) => FAV_VALUES.flatMap(fav => [false, true].map(includeGroups => ({
    label: `${label}, fav ${fav}, includeGroups ${includeGroups}`,
    filter: { ...(tags ? { tags } : {}), ...(fav === undefined ? {} : { fav }), ...(includeGroups ? { includeGroups } : {}) },
}))));

describe('/query totals from the stored counters', () => {
    test('each counted shape, with and without groups, equals the COUNT(*) statement\'s total, and reads no COUNT(*) once the fill is done', async () => {
        await seedLibrary();

        const before = [];
        for (const { filter } of COUNTED_CASES) {
            const result = await jsonTotal(filter);
            expect(result.counted).toBe(true);
            before.push(result.total);
        }
        await fill();

        for (const [i, { label, filter }] of COUNTED_CASES.entries()) {
            const json = await jsonTotal(filter);
            expect({ label, ...json }).toEqual({ label, total: before[i], counted: false });
            const binary = await binaryTotal(filter);
            expect({ label, ...binary }).toEqual({ label, total: before[i], approx: false, counted: false });
        }
    });

    test('the totals come from the counters: a changed counter shows in them', async () => {
        await seedLibrary();
        await fill();
        const plain = (await jsonTotal({ fav: false })).total;
        const withGroups = (await jsonTotal({ fav: false, includeGroups: true })).total;
        const tagged = (await jsonTotal({ tags: { include: ['t1'] }, includeGroups: true })).total;
        withRawDb(db => {
            db.prepare('UPDATE entity_counts SET count = count + 1000 WHERE kind = \'character\' AND fav = 0').run();
            db.prepare('UPDATE entity_counts SET count = count + 100 WHERE kind = \'group\' AND fav = 0').run();
            db.prepare('UPDATE entity_tag_counts SET count = count + 10 WHERE tag_id = \'t1\' AND kind = \'group\' AND fav = 1').run();
        });
        expect((await jsonTotal({ fav: false })).total).toBe(plain + 1000);
        expect((await jsonTotal({ fav: false, includeGroups: true })).total).toBe(withGroups + 1100);
        expect((await jsonTotal({ tags: { include: ['t1'] }, includeGroups: true })).total).toBe(tagged + 10);
    });

    test('writes after the fill keep the totals equal to the COUNT(*) statement\'s', async () => {
        await seedLibrary();
        await fill();
        await seedCharacter('f.png', true);
        await assign('f.png', 't2');
        expect(await metadataDb.setCharacterFav(directories, 'b.png', true)).toBe(true);
        await seedGroup('gd', true);
        await assign('gd', 't1');
        expect(await metadataDb.unassignEntityTag(directories, 'e.png', 't1')).toBe('ok');

        const after = [];
        for (const { filter } of COUNTED_CASES) after.push((await jsonTotal(filter)).total);
        withRawDb(db => db.prepare('UPDATE entity_count_fill SET done = 0').run());
        for (const [i, { label, filter }] of COUNTED_CASES.entries()) {
            const result = await jsonTotal(filter);
            expect(result.counted).toBe(true);
            expect({ label, total: result.total }).toEqual({ label, total: after[i] });
        }
    });

    test('until the fill is done, the COUNT(*) statement runs; the characters-only total needs only the characters fill', async () => {
        await seedLibrary();
        expect((await jsonTotal({})).counted).toBe(true);
        expect((await jsonTotal({ includeGroups: true })).counted).toBe(true);
        expect(await jsonTotal({ tags: { include: ['t1', 't2'] } })).toEqual({ total: 1, counted: true });
        expect(await jsonTotal({ tags: { exclude: ['t1', 't2'] }, includeGroups: true })).toEqual({ total: 2, counted: true });
        expect(await jsonTotal({ world: 'lore' })).toEqual({ total: 1, counted: true });
        expect(iterated.filter(isSampleRead)).toEqual([]);

        await fill();
        withRawDb(db => db.prepare('UPDATE entity_count_fill SET done = 0 WHERE kind = \'group\'').run());
        expect(await jsonTotal({})).toEqual({ total: 6, counted: false });
        expect(await jsonTotal({ includeGroups: true })).toEqual({ total: 9, counted: true });

        withRawDb(db => db.prepare('UPDATE entity_count_fill SET done = CASE kind WHEN \'group\' THEN 1 ELSE 0 END').run());
        expect(await jsonTotal({})).toEqual({ total: 6, counted: true });
        expect(await jsonTotal({ includeGroups: true })).toEqual({ total: 9, counted: true });
    });

    test.each([
        ['two included tags', { tags: { include: ['t1', 't2'] } }, 1, 1],
        ['two included tags, or mode', { tags: { include: ['t1', 't2'], mode: 'or' } }, 5, 7],
        ['a repeated included tag', { tags: { include: ['t1', 't1'] } }, 0, 0],
        ['an included and an excluded tag', { tags: { include: ['t1'], exclude: ['t2'] } }, 3, 4],
        ['two excluded tags', { tags: { exclude: ['t1', 't2'] } }, 1, 2],
        ['excludeIds', { excludeIds: ['a.png', 'ga', 'missing.png'] }, 5, 7],
        ['excludeIds with fav and one included tag', { excludeIds: ['a.png', 'ga', 'b.png'], fav: true, tags: { include: ['t1'] } }, 0, 0],
        ['world', { world: 'lore' }, 1, 4],
    ])('a shape with no single counter, on a store the sample covers whole, is exact with no COUNT(*): %s', async (_label, filter, charactersTotal, entitiesTotal) => {
        await seedLibrary();
        const before = [(await jsonTotal(filter)).total, (await jsonTotal({ ...filter, includeGroups: true })).total];
        expect(before).toEqual([charactersTotal, entitiesTotal]);
        await fill();
        expect(await jsonTotal(filter)).toEqual({ total: charactersTotal, counted: false });
        expect(await binaryTotal({ ...filter, includeGroups: true })).toEqual({ total: entitiesTotal, approx: false, counted: false });
    });

    test('an id list keeps the COUNT(*) statement', async () => {
        await seedLibrary();
        await fill();
        expect(await jsonTotal({ ids: ['a.png', 'b.png', 'ga'] })).toEqual({ total: 2, counted: true });
        expect(await jsonTotal({ ids: ['a.png', 'b.png', 'ga'], includeGroups: true })).toEqual({ total: 3, counted: true });
    });
});

describe('/query totals while a tag is marked deleted', () => {
    // After seedLibrary(), t2 marked as merging into t1. Its rows stay under t2 until finishDeletedTags() moves them.
    // Request-level counters: t1 is a, b, e, w + ga; t2 is a, d + gb.
    async function seedMerged() {
        await seedLibrary();
        await fill();
        expect(await metadataDb.deleteTagDefinition(directories, 't2', 't1')).toMatchObject({ refused: [] });
    }

    test.each([
        ['the target', 't1'],
        ['the marked tag, which acts on its target', 't2'],
    ])('one included tag naming %s is the sum of its counters, sent approximate in JSON and binary', async (_label, tagId) => {
        await seedMerged();
        // characters: t1 4 + t2 2; groups: t1 1 + t2 1. The true union is 5 characters, 2 groups.
        expect(await jsonTotal({ tags: { include: [tagId] } })).toEqual({ total: '~6', counted: false });
        expect(await binaryTotal({ tags: { include: [tagId] } })).toEqual({ total: 6, approx: true, counted: false });
        expect(await jsonTotal({ tags: { include: [tagId] }, includeGroups: true })).toEqual({ total: '~8', counted: false });
        expect(await binaryTotal({ tags: { include: [tagId] }, includeGroups: true })).toEqual({ total: 8, approx: true, counted: false });
        // fav true: a (t1, t2) + ga (t1).
        expect(await jsonTotal({ tags: { include: [tagId] }, fav: true, includeGroups: true })).toEqual({ total: '~3', counted: false });
    });

    test('one excluded tag with merges is the midpoint between total minus the sum and total minus the largest counter', async () => {
        await seedMerged();
        // characters: total 6, t1 4, t2 2 -> bounds 0 and 2 -> 1.
        expect(await jsonTotal({ tags: { exclude: ['t1'] } })).toEqual({ total: '~1', counted: false });
        expect(await binaryTotal({ tags: { exclude: ['t2'] } })).toEqual({ total: 1, approx: true, counted: false });
        // with groups: total 9, t1 5, t2 3 -> bounds 1 and 4 -> 2.5, rounded 3.
        expect(await jsonTotal({ tags: { exclude: ['t1'] }, includeGroups: true })).toEqual({ total: '~3', counted: false });
        expect(await binaryTotal({ tags: { exclude: ['t1'] }, includeGroups: true })).toEqual({ total: 3, approx: true, counted: false });
        // fav false, with groups: total 6 (b, d, e, w, gb, gc), t1 3 (b, e, w), t2 2 (d, gb) -> bounds 1 and 3 -> 2.
        expect(await jsonTotal({ tags: { exclude: ['t1'] }, fav: false, includeGroups: true })).toEqual({ total: '~2', counted: false });
    });

    test('an excluded tag with merges whose lower bound is below zero is clamped at 0', async () => {
        await saveTags(['t1', 't2']);
        await seedCharacter('x.png');
        await seedCharacter('y.png');
        for (const id of ['x.png', 'y.png']) {
            await assign(id, 't1');
            await assign(id, 't2');
        }
        await fill();
        expect(await metadataDb.deleteTagDefinition(directories, 't2', 't1')).toMatchObject({ refused: [] });
        // total 2, t1 2, t2 2 -> bounds -2 and 0 -> midpoint -1 -> 0.
        expect(await jsonTotal({ tags: { exclude: ['t1'] } })).toEqual({ total: '~0', counted: false });
        expect(await binaryTotal({ tags: { exclude: ['t1'] }, includeGroups: true })).toEqual({ total: 0, approx: true, counted: false });
    });

    test('a tag deleted with no target: included it matches nothing, excluded it excludes nothing, both exact, as the COUNT(*) statement has it', async () => {
        await seedLibrary();
        await fill();
        expect(await metadataDb.deleteTagDefinition(directories, 't2')).toMatchObject({ refused: [] });
        const cases = [
            [{ tags: { include: ['t2'] } }, 0],
            [{ tags: { include: ['t2'] }, includeGroups: true }, 0],
            [{ tags: { include: ['t2'], mode: 'or' }, includeGroups: true }, 0],
            [{ tags: { exclude: ['t2'] } }, 6],
            [{ tags: { exclude: ['t2'] }, fav: true, includeGroups: true }, 3],
        ];
        for (const [filter, total] of cases) {
            expect(await jsonTotal(filter)).toEqual({ total, counted: false });
            expect(await binaryTotal(filter)).toEqual({ total, approx: false, counted: false });
        }
        withRawDb(db => db.prepare('UPDATE entity_count_fill SET done = 0').run());
        for (const [filter, total] of cases) expect(await jsonTotal(filter)).toEqual({ total, counted: true });
    });

    test('a tag no mark touches stays exact while another tag is marked', async () => {
        await seedLibrary();
        await fill();
        expect(await metadataDb.deleteTagDefinition(directories, 't3', 't2')).toMatchObject({ refused: [] });
        expect(await jsonTotal({ tags: { include: ['t1'] }, includeGroups: true })).toEqual({ total: 5, counted: false });
        expect(await binaryTotal({ tags: { exclude: ['t1'] }, includeGroups: true })).toEqual({ total: 4, approx: false, counted: false });
    });
});

describe('/query approximate total form', () => {
    test('the counted path\'s approximate JSON total has the same `~<number>` form as the search path\'s', async () => {
        // The search sort with a capped id list sends an approximate total.
        for (let i = 0; i < 8; i++) await seedCharacterWithFile(`zephyr${i}.png`, `Zephyr ${i}`);
        const searchResponse = await postJson({ filter: { search: 'zephyr' }, sort: { field: 'search' }, page: 1, pageSize: 1 });
        expect(searchResponse.status).toBe(200);
        const searchTotal = (await searchResponse.json()).total;

        await saveTags(['t1', 't2']);
        await assign('zephyr0.png', 't1');
        await assign('zephyr1.png', 't2');
        await fill();
        expect(await metadataDb.deleteTagDefinition(directories, 't2', 't1')).toMatchObject({ refused: [] });
        const { total } = await jsonTotal({ tags: { include: ['t1'] } });
        expect(typeof total).toBe(typeof searchTotal);
        expect(total).toMatch(/^~\d+$/);
        expect(searchTotal).toMatch(/^~\d+$/);
        expect(total).toBe('~2');
    }, 20000);
});

/** A read of the count sampler: a run of a tag's rows or of an entity table, or a whole population read at once. */
const isSampleRead = (/** @type {{ sql: string }} */ record) => record.sql.includes('@len');
const sampleReads = () => iterated.filter(isSampleRead);
const sampledRows = () => sampleReads().reduce((n, record) => n + record.rows, 0);

const SAMPLE_BUDGET = 10000;
/** An estimate is within 10% of the true count, or within 25 when the count is small. */
const TOLERANCE = (/** @type {number} */ truth) => Math.max(0.1 * truth, 25);

const BIG_CHARACTERS = 30000;
const BIG_GROUPS = 10000;
/** A pseudo-random value in 0..99 for row i, a different one per prime: unrelated to id order and to the other primes' values. */
const bucketSql = (/** @type {number} */ prime) => `((i * ${prime}) % 10007) % 100`;
const SEQ_CTE = 'WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < @n - 1)';

/**
 * Copies `template`'s row of `table` n times through a raw connection, with the given column expressions over the
 * row number i. The counter triggers count the copies, since the fill is done by then.
 * @param {import('better-sqlite3').Database} db
 */
function copyRows(db, table, template, n, overrides) {
    const columns = Array.from(db.prepare(`PRAGMA table_info(${table})`).iterate(), c => c.name);
    const values = columns.map(c => overrides[c] ?? `t.${c}`);
    db.prepare(`${SEQ_CTE} INSERT INTO ${table} (${columns.join(', ')}) SELECT ${values.join(', ')} FROM seq, ${table} t WHERE t.id = @template`).run({ n, template });
}

/**
 * Characters c000000.png..c029999.png and groups g000000..g009999, besides the templates tmpl.png and gtmpl.
 * t1 is on 70% of each, t2 on 50%, t3 on 40%, fav on 15%, and world 'lore' on 30% of characters, each drawn by
 * bucketSql() so they don't follow id order or each other.
 */
async function seedBigStore() {
    await saveTags(['t1', 't2', 't3']);
    await seedCharacter('tmpl.png');
    await seedGroup('gtmpl');
    await fill();
    withRawDb(db => db.transaction(() => {
        copyRows(db, 'characters', 'tmpl.png', BIG_CHARACTERS, {
            id: 'printf(\'c%06d.png\', i)', name_fold: 'printf(\'c%06d\', i)',
            fav: `${bucketSql(15485863)} < 15`, world: `CASE WHEN ${bucketSql(179424673)} < 30 THEN 'lore' ELSE '' END`,
        });
        copyRows(db, 'groups', 'gtmpl', BIG_GROUPS, {
            id: 'printf(\'g%06d\', i)', name: 'printf(\'g%06d\', i)', name_fold: 'printf(\'g%06d\', i)', fav: `${bucketSql(15485863)} < 15`,
        });
        for (const [tagId, prime, percent] of [['t1', 7919, 70], ['t2', 104729, 50], ['t3', 1299709, 40]]) {
            db.prepare(`${SEQ_CTE} INSERT INTO character_tags (character_id, tag_id) SELECT printf('c%06d.png', i), @tagId FROM seq WHERE ${bucketSql(prime)} < @percent`)
                .run({ n: BIG_CHARACTERS, tagId, percent });
            db.prepare(`${SEQ_CTE} INSERT INTO group_tags (group_id, tag_id) SELECT printf('g%06d', i), @tagId FROM seq WHERE ${bucketSql(prime)} < @percent`)
                .run({ n: BIG_GROUPS, tagId, percent });
        }
    })());
}

/** The COUNT(*) statement's totals for these filters, read with the fill marked not done. */
async function trueTotals(filters) {
    withRawDb(db => db.prepare('UPDATE entity_count_fill SET done = 0').run());
    const totals = [];
    for (const filter of filters) {
        const result = await jsonTotal(filter);
        expect(result.counted).toBe(true);
        totals.push(result.total);
    }
    withRawDb(db => db.prepare('UPDATE entity_count_fill SET done = 1').run());
    return totals;
}

/** @param {unknown} total @returns {number} */
function approxValue(total) {
    expect(typeof total).toBe('string');
    expect(total).toMatch(/^~\d+$/);
    return Number(String(total).slice(1));
}

const ESTIMATED_TAG_SHAPES = [
    ['two included tags', { include: ['t1', 't2'] }],
    ['three included tags', { include: ['t1', 't2', 't3'] }],
    ['an included and an excluded tag', { include: ['t1'], exclude: ['t2'] }],
    ['two excluded tags', { exclude: ['t1', 't2'] }],
    ['two included tags, or mode', { include: ['t2', 't3'], mode: 'or' }],
    ['three included tags, or mode', { include: ['t3', 't2', 't1'], mode: 'or' }],
];
const ESTIMATED_CASES = ESTIMATED_TAG_SHAPES.flatMap(([label, tags]) => FAV_VALUES.flatMap(fav => [false, true].map(includeGroups => ({
    label: `${label}, fav ${fav}, includeGroups ${includeGroups}`,
    filter: { tags, ...(fav === undefined ? {} : { fav }), ...(includeGroups ? { includeGroups } : {}) },
}))));

describe('/query sampled estimates', () => {
    test('each estimated shape, with and without groups, sends ~ and a value within tolerance of the COUNT(*) total, reading at most the sample budget', async () => {
        await seedBigStore();
        const truths = await trueTotals(ESTIMATED_CASES.map(c => c.filter));
        for (const [i, { label, filter }] of ESTIMATED_CASES.entries()) {
            const { total, counted } = await jsonTotal(filter);
            expect({ label, counted }).toEqual({ label, counted: false });
            const estimate = approxValue(total);
            expect({ label, off: Math.abs(estimate - truths[i]) <= TOLERANCE(truths[i]), estimate, truth: truths[i] }).toEqual({ label, off: true, estimate, truth: truths[i] });
            expect({ label, sampled: sampledRows() > 0 && sampledRows() <= SAMPLE_BUDGET }).toEqual({ label, sampled: true });
        }
        const binary = await binaryTotal(ESTIMATED_CASES[0].filter);
        expect(binary.approx).toBe(true);
        expect(binary.counted).toBe(false);
    }, 120000);

    test('world is estimated by sampling the characters; the groups, which world doesn\'t filter, are counted exactly', async () => {
        await seedBigStore();
        const filters = [{ world: 'lore' }, { world: 'lore', fav: true }, { world: 'lore', includeGroups: true }, { world: 'lore', tags: { exclude: ['t1'] }, includeGroups: true }];
        const truths = await trueTotals(filters);
        for (const [i, filter] of filters.entries()) {
            const { total, counted } = await jsonTotal(filter);
            expect(counted).toBe(false);
            expect(Math.abs(approxValue(total) - truths[i])).toBeLessThanOrEqual(TOLERANCE(truths[i]));
            expect(sampleReads().every(record => !record.sql.includes('group'))).toBe(true);
        }
    }, 60000);

    test('excludeIds on a counted shape stays exact: the counter minus the listed ids that exist and match', async () => {
        await seedBigStore();
        const listed = [...Array.from({ length: 200 }, (_, i) => `c${String(i * 37).padStart(6, '0')}.png`), 'g000003', 'g000004', 'missing.png', 'c000037.png'];
        const filters = [
            { excludeIds: listed }, { excludeIds: listed, fav: true, includeGroups: true },
            { excludeIds: listed, tags: { include: ['t1'] }, includeGroups: true }, { excludeIds: listed, tags: { exclude: ['t2'] }, fav: false },
        ];
        const truths = await trueTotals(filters);
        for (const [i, filter] of filters.entries()) {
            expect(await jsonTotal(filter)).toEqual({ total: truths[i], counted: false });
            expect(sampleReads()).toEqual([]);
        }
    }, 60000);

    test('the same query and change seq give the same estimate from the same runs; a write that moves the seq picks new runs', async () => {
        await seedBigStore();
        const filter = { tags: { include: ['t1', 't2'] }, includeGroups: true };
        const first = await jsonTotal(filter);
        const firstRuns = sampleReads().map(record => record.params);
        const second = await jsonTotal(filter);
        expect(second).toEqual(first);
        expect(sampleReads().map(record => record.params)).toEqual(firstRuns);

        expect(await metadataDb.setCharacterFav(directories, 'tmpl.png', true)).toBe(true);
        await jsonTotal(filter);
        expect(sampleReads().map(record => record.params)).not.toEqual(firstRuns);
    }, 60000);

    test('with groups the budget is split between the kinds in proportion to their counters, and each share is read in full', async () => {
        await seedBigStore();
        const sizes = withRawDb(db => Object.fromEntries(Array.from(db.prepare('SELECT kind, SUM(count) AS n FROM entity_tag_counts WHERE tag_id = \'t3\' GROUP BY kind').iterate(), r => [r.kind, r.n])));
        const all = sizes.character + sizes.group;
        const characterShare = Math.floor(SAMPLE_BUDGET * sizes.character / all);
        const groupShare = Math.floor(SAMPLE_BUDGET * sizes.group / all);

        // t3 has the smallest counter of the two, so it is the one sampled.
        await jsonTotal({ tags: { include: ['t2', 't3'] }, includeGroups: true });
        const rowsFrom = (/** @type {string} */ table) => sampleReads().filter(record => record.sql.includes(`FROM ${table} `)).reduce((n, record) => n + record.rows, 0);
        expect(rowsFrom('character_tags')).toBe(characterShare);
        expect(rowsFrom('group_tags')).toBe(groupShare);
        expect(sampleReads().every(record => record.params.tagId === 't3')).toBe(true);
    }, 60000);

    test('runs over ids c000000.png..c029999.png read close to the budget in distinct rows, spread across the range', async () => {
        await seedBigStore();
        await jsonTotal({ tags: { exclude: ['t1', 't2'] } });
        const ids = new Set(sampleReads().flatMap(record => record.ids));
        expect(sampledRows()).toBe(SAMPLE_BUDGET);
        expect(ids.size).toBeGreaterThanOrEqual(0.75 * SAMPLE_BUDGET);
        // Ten equal slices of the id range: most get rows, and none holds more than a quarter of them.
        const slices = new Array(10).fill(0);
        for (const id of ids) {
            const match = /^c(\d{6})\.png$/.exec(id);
            if (match) slices[Math.floor(Number(match[1]) / (BIG_CHARACTERS / 10))]++;
        }
        expect(slices.filter(n => n > 0).length).toBeGreaterThanOrEqual(7);
        expect(Math.max(...slices)).toBeLessThanOrEqual(0.25 * ids.size);
    }, 60000);

    test('an included tag with merges, the only included tag: runs of its rows and each merged tag\'s, deduped, scaled by the sum', async () => {
        await seedBigStore();
        expect(await metadataDb.deleteTagDefinition(directories, 't3', 't2')).toMatchObject({ refused: [] });
        const filter = { tags: { include: ['t2'], exclude: ['t1'] } };
        const expected = withRawDb(db => {
            const union = 'SELECT DISTINCT character_id AS id FROM character_tags WHERE tag_id IN (\'t2\', \'t3\')';
            const all = db.prepare(`SELECT COUNT(*) AS n FROM (${union})`).get().n;
            const kept = db.prepare(`SELECT COUNT(*) AS n FROM (${union}) u WHERE NOT EXISTS (SELECT 1 FROM character_tags t WHERE t.character_id = u.id AND t.tag_id = 't1')`).get().n;
            const sum = db.prepare('SELECT SUM(count) AS n FROM entity_tag_counts WHERE kind = \'character\' AND tag_id IN (\'t2\', \'t3\')').get().n;
            return kept / all * sum;
        });
        const { total, counted } = await jsonTotal(filter);
        expect(counted).toBe(false);
        expect(Math.abs(approxValue(total) - expected)).toBeLessThanOrEqual(TOLERANCE(expected));
        const tagsRead = new Set(sampleReads().map(record => record.params.tagId));
        expect([...tagsRead].sort()).toEqual(['t2', 't3']);
        expect(sampledRows()).toBeLessThanOrEqual(SAMPLE_BUDGET);
    }, 60000);

    test('an included tag with merges that another included tag can stand in for is not the one sampled', async () => {
        await seedBigStore();
        expect(await metadataDb.deleteTagDefinition(directories, 't3', 't2')).toMatchObject({ refused: [] });
        await jsonTotal({ tags: { include: ['t1', 't2'] } });
        expect(new Set(sampleReads().map(record => record.params.tagId))).toEqual(new Set(['t1']));
    }, 60000);

    test('an included tag with merges on a store the sample covers whole is exact', async () => {
        await seedLibrary();
        await fill();
        expect(await metadataDb.deleteTagDefinition(directories, 't2', 't1')).toMatchObject({ refused: [] });
        expect(await jsonTotal({ tags: { include: ['t1'], exclude: ['t3'] } })).toEqual({ total: 5, counted: false });
        expect(await binaryTotal({ tags: { include: ['t1'], exclude: ['t3'] }, includeGroups: true })).toEqual({ total: 7, approx: false, counted: false });
    });

    test('or mode: an estimate below the largest counter is clamped up to it', async () => {
        // tb holds 14,000 characters m000000.png.. and 1,000 z0000.png.. that also carry ta; 60,000 untagged
        // y000000.png.. make most run starts land past the m ids, so tb's runs over-read the z ids that carry ta.
        await saveTags(['ta', 'tb']);
        await seedCharacter('tmpl.png');
        await fill();
        withRawDb(db => db.transaction(() => {
            copyRows(db, 'characters', 'tmpl.png', 14000, { id: 'printf(\'m%06d.png\', i)' });
            copyRows(db, 'characters', 'tmpl.png', 60000, { id: 'printf(\'y%06d.png\', i)' });
            copyRows(db, 'characters', 'tmpl.png', 1000, { id: 'printf(\'z%04d.png\', i)' });
            db.prepare('INSERT INTO character_tags (character_id, tag_id) SELECT id, \'tb\' FROM characters WHERE id LIKE \'m%\' OR id LIKE \'z%\'').run();
            db.prepare('INSERT INTO character_tags (character_id, tag_id) SELECT id, \'ta\' FROM characters WHERE id LIKE \'z%\'').run();
        })());
        expect(await jsonTotal({ tags: { include: ['ta', 'tb'], mode: 'or' } })).toEqual({ total: '~15000', counted: false });
    }, 60000);
});

describe('/query with an id list and excluded tags', () => {
    const rowIds = (/** @type {any[]} */ rows) => rows.map(r => r.type === 'group' ? r.item.id : (r.avatar ?? r.item?.avatar));

    async function query(filter) {
        const response = await postJson({ filter, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 50, want: ['rows', 'total'] });
        expect(response.status).toBe(200);
        const body = await response.json();
        return { total: body.total, rows: rowIds(body.rows) };
    }

    test('returns the same rows and totals, with and without groups, with and without a marked tag', async () => {
        await seedLibrary();
        const ids = ['a.png', 'b.png', 'c.png', 'd.png', 'ga', 'gb', 'gc'];
        expect(await query({ ids, tags: { exclude: ['t2'] } })).toEqual({ total: 2, rows: ['b.png', 'c.png'] });
        expect(await query({ ids, tags: { exclude: ['t1', 't2'] } })).toEqual({ total: 1, rows: ['c.png'] });
        expect(await query({ ids, tags: { include: ['t1'], exclude: ['t2'] }, includeGroups: true })).toEqual({ total: 2, rows: ['b.png', 'ga'] });
        expect(await query({ ids, tags: { exclude: ['t2'] }, includeGroups: true })).toEqual({ total: 4, rows: ['b.png', 'c.png', 'ga', 'gc'] });

        expect(await metadataDb.deleteTagDefinition(directories, 't2', 't1')).toMatchObject({ refused: [] });
        expect(await query({ ids, tags: { exclude: ['t1'] }, includeGroups: true })).toEqual({ total: 2, rows: ['c.png', 'gc'] });
        expect(await query({ ids, tags: { exclude: ['t2'] } })).toEqual({ total: 1, rows: ['c.png'] });
    });
});
