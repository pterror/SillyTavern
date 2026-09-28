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

/** @param {any} handle */
function recordingHandle(handle) {
    const wrapped = { ...handle };
    for (const method of ['get', 'all', 'iterate']) {
        wrapped[method] = (sql, params) => {
            readSql.push(sql);
            return handle[method](sql, params);
        };
    }
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
    withRawDb(db => expect(db.prepare('SELECT kind, done FROM entity_count_fill ORDER BY kind').all()).toEqual([
        { kind: 'character', done: 1 }, { kind: 'group', done: 1 },
    ]));
}

async function postJson(body) {
    return fetch(`${baseUrl}/api/characters/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** The JSON total of one request, and whether the COUNT(*) statement ran for it. */
async function jsonTotal(filter) {
    readSql = [];
    const response = await postJson({ filter, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 2, want: ['rows', 'total'] });
    expect(response.status).toBe(200);
    const body = await response.json();
    return { total: body.total, counted: countRan() };
}

/** The binary hash-mode header of one request: its total, whether it's flagged approximate, and whether COUNT(*) ran. */
async function binaryTotal(filter) {
    readSql = [];
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
        ['a repeated included tag', { tags: { include: ['t1', 't1'] } }, 0, 0],
        ['an included and an excluded tag', { tags: { include: ['t1'], exclude: ['t2'] } }, 3, 4],
        ['two excluded tags', { tags: { exclude: ['t1', 't2'] } }, 1, 2],
        ['excludeIds', { excludeIds: ['a.png', 'ga'] }, 5, 7],
        ['world', { world: 'lore' }, 1, 4],
        ['ids', { ids: ['a.png', 'b.png', 'ga'] }, 2, 3],
    ])('a shape with no single counter keeps the COUNT(*) statement: %s', async (_label, filter, charactersTotal, entitiesTotal) => {
        await seedLibrary();
        await fill();
        expect(await jsonTotal(filter)).toEqual({ total: charactersTotal, counted: true });
        expect(await jsonTotal({ ...filter, includeGroups: true })).toEqual({ total: entitiesTotal, counted: true });
    });
});

describe('/query totals while a tag is marked deleted', () => {
    // After seedLibrary(), t2 marked as merging into t1. Its rows stay under t2 until finishDeletedTags() moves them.
    // Request-level counters: t1 is a, b, e, w + ga; t2 is a, d + gb.
    async function seedMerged() {
        await seedLibrary();
        await fill();
        expect(await metadataDb.deleteTagDefinition(directories, 't2', 't1')).toBe('ok');
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
        expect(await metadataDb.deleteTagDefinition(directories, 't2', 't1')).toBe('ok');
        // total 2, t1 2, t2 2 -> bounds -2 and 0 -> midpoint -1 -> 0.
        expect(await jsonTotal({ tags: { exclude: ['t1'] } })).toEqual({ total: '~0', counted: false });
        expect(await binaryTotal({ tags: { exclude: ['t1'] }, includeGroups: true })).toEqual({ total: 0, approx: true, counted: false });
    });

    test('a tag deleted with no target: included it matches nothing, excluded it excludes nothing, both exact, as the COUNT(*) statement has it', async () => {
        await seedLibrary();
        await fill();
        expect(await metadataDb.deleteTagDefinition(directories, 't2')).toBe('ok');
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
        expect(await metadataDb.deleteTagDefinition(directories, 't3', 't2')).toBe('ok');
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
        expect(await metadataDb.deleteTagDefinition(directories, 't2', 't1')).toBe('ok');
        const { total } = await jsonTotal({ tags: { include: ['t1'] } });
        expect(typeof total).toBe(typeof searchTotal);
        expect(total).toMatch(/^~\d+$/);
        expect(searchTotal).toMatch(/^~\d+$/);
        expect(total).toBe('~2');
    }, 20000);
});
