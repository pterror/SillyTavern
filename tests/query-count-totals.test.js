import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

// POST /api/characters/query's total, for the filter shapes the page asks: no filter, fav alone, tags included and
// excluded, a world, an id list, and a search; with and without groups; in JSON and in the binary hash header. Each is
// compared with the count of the entities of a small library that match it.

/** @type {import('express').Router} */
let router;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/library-codes.js').TYPE} */
let TYPE;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/characters.js'));
    fixture = await import('./converted-user.fixture.js');
    ({ TYPE } = await import('../src/library-codes.js'));
    cardParser = await import('../src/character-card-parser.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-query-count-totals-test-');
    directories = user.directories;
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

/** @param {string} name @param {boolean} fav */
function cardFor(name, fav) {
    return {
        name, fav, spec: 'chara_card_v2', spec_version: '2.0',
        data: { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav, world: '' } },
    };
}

async function seedCharacter(id, fav = false) {
    await user.store.lib.writeCard(directories, id, JSON.stringify(cardFor(id.replace(/\.png$/, ''), fav)));
}

async function seedCharacterWithFile(id, name) {
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const card = JSON.stringify(cardFor(name, false));
    await fixture.writeCardWithImage(user, id, card, cardParser.write(baseImage, card));
}

async function seedGroup(id, fav = false) {
    await user.store.lib.writeGroup({ id, name: id, members: [], fav });
}

/** @param {string[]} ids */
async function saveTags(ids) {
    for (const id of ids) await user.store.lib.tags.create({ id, name: `name-${id}` });
}

async function assign(id, tagId) {
    expect((await user.store.lib.tags.assign(id, tagId)).result).toBe('ok');
}

/** The library the totals are of: each entity with its fav, tags and world. */
const LIBRARY = [
    { id: 'a.png', group: false, fav: true, tags: ['t1', 't2'] },
    { id: 'b.png', group: false, fav: false, tags: ['t1'] },
    { id: 'c.png', group: false, fav: true, tags: [] },
    { id: 'd.png', group: false, fav: false, tags: ['t2'] },
    { id: 'e.png', group: false, fav: false, tags: ['t1'] },
    { id: 'w.png', group: false, fav: false, tags: ['t1'], world: 'lore' },
    { id: 'ga', group: true, fav: true, tags: ['t1'] },
    { id: 'gb', group: true, fav: false, tags: ['t2'] },
    { id: 'gc', group: true, fav: false, tags: [] },
];

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
    await user.store.lib.writeCard(directories, 'w.png', JSON.stringify(lore));
    await seedGroup('ga', true);
    await seedGroup('gb');
    await seedGroup('gc');
    for (const id of ['a.png', 'b.png', 'e.png', 'w.png', 'ga']) await assign(id, 't1');
    for (const id of ['a.png', 'd.png', 'gb']) await assign(id, 't2');
}

async function postJson(body) {
    return fetch(`${baseUrl}/api/characters/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** The JSON total of one request. */
async function jsonTotal(filter) {
    const response = await postJson({ filter, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 2, want: ['rows', 'total'] });
    expect(response.status).toBe(200);
    return (await response.json()).total;
}

/** The binary hash-mode header of one request: its total, and whether it's flagged approximate. */
async function binaryTotal(filter) {
    const response = await postJson({ filter, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 2, want: ['hashes', 'total'] });
    expect(response.status).toBe(200);
    const view = new DataView(await response.arrayBuffer());
    const flags = view.getUint8(0);
    expect(flags & 0b01).toBe(0b01);
    return { total: view.getFloat64(1 + 1 + 8, true), approx: (flags & 0b10) !== 0 };
}

/**
 * How many entities of LIBRARY a filter matches.
 * @param {{ tags?: { include?: string[], exclude?: string[], mode?: string }, fav?: boolean, includeGroups?: boolean, world?: string, excludeIds?: string[] }} filter
 */
function modelTotal(filter) {
    const include = (filter.tags?.include ?? []).filter(Boolean);
    const exclude = (filter.tags?.exclude ?? []).filter(Boolean);
    return LIBRARY.filter(e => (filter.includeGroups || !e.group)
        && (filter.fav === undefined || e.fav === filter.fav)
        && (include.length === 0 || (filter.tags?.mode === 'or' ? include.some(t => e.tags.includes(t)) : include.every(t => e.tags.includes(t))))
        && !exclude.some(t => e.tags.includes(t))
        && (filter.world === undefined || (!e.group && e.world === filter.world))
        && !(filter.excludeIds ?? []).includes(e.id)).length;
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

describe('/query totals', () => {
    test('each counted shape, with and without groups, equals the count of the entities it matches, in JSON and binary', async () => {
        await seedLibrary();
        for (const { label, filter } of COUNTED_CASES) {
            const want = modelTotal(filter);
            expect({ label, total: await jsonTotal(filter) }).toEqual({ label, total: want });
            expect({ label, ...await binaryTotal(filter) }).toEqual({ label, total: want, approx: false });
        }
    });

    test('writes keep the totals equal to the count of the entities they match', async () => {
        await seedLibrary();
        await seedCharacter('f.png', true);
        LIBRARY.push({ id: 'f.png', group: false, fav: true, tags: ['t2'] });
        await assign('f.png', 't2');
        expect(await user.store.lib.setFav(TYPE.character, 'b.png', true)).toBe(true);
        LIBRARY.find(e => e.id === 'b.png').fav = true;
        await seedGroup('gd', true);
        LIBRARY.push({ id: 'gd', group: true, fav: true, tags: ['t1'] });
        await assign('gd', 't1');
        expect((await user.store.lib.tags.unassign('e.png', 't1'))).toBe('ok');
        LIBRARY.find(e => e.id === 'e.png').tags = [];
        try {
            for (const { label, filter } of COUNTED_CASES) {
                expect({ label, total: await jsonTotal(filter) }).toEqual({ label, total: modelTotal(filter) });
            }
        } finally {
            LIBRARY.splice(LIBRARY.findIndex(e => e.id === 'f.png'), 1);
            LIBRARY.splice(LIBRARY.findIndex(e => e.id === 'gd'), 1);
            LIBRARY.find(e => e.id === 'b.png').fav = false;
            LIBRARY.find(e => e.id === 'e.png').tags = ['t1'];
        }
    });

    test.each([
        ['two included tags', { tags: { include: ['t1', 't2'] } }, 1, 1],
        // As upstream's tag filter: each included tag must be carried, so a repeated one is that tag.
        ['a repeated included tag', { tags: { include: ['t1', 't1'] } }, 4, 5],
        ['an included and an excluded tag', { tags: { include: ['t1'], exclude: ['t2'] } }, 3, 4],
        ['two excluded tags', { tags: { exclude: ['t1', 't2'] } }, 1, 2],
        ['excludeIds', { excludeIds: ['a.png', 'ga', 'missing.png'] }, 5, 7],
        ['excludeIds with fav and one included tag', { excludeIds: ['a.png', 'ga', 'b.png'], fav: true, tags: { include: ['t1'] } }, 0, 0],
        ['world', { world: 'lore' }, 1, 4],
    ])('a shape with several tags or ids is exact: %s', async (_label, filter, charactersTotal, entitiesTotal) => {
        await seedLibrary();
        expect(await jsonTotal(filter)).toBe(charactersTotal);
        expect(await binaryTotal({ ...filter, includeGroups: true })).toEqual({ total: entitiesTotal, approx: false });
    });

    test('two included tags in or mode: exact when the page reads every match, else marked approximate', async () => {
        await seedLibrary();
        const filter = { tags: { include: ['t1', 't2'], mode: 'or' } };
        expect(await jsonTotal(filter)).toBe(modelTotal(filter));
        const binary = await binaryTotal({ ...filter, includeGroups: true });
        expect(binary.approx || binary.total === modelTotal({ ...filter, includeGroups: true })).toBe(true);
    });

    test('an id list counts the ids that exist and match', async () => {
        await seedLibrary();
        expect(await jsonTotal({ ids: ['a.png', 'b.png', 'ga'] })).toBe(2);
        expect(await jsonTotal({ ids: ['a.png', 'b.png', 'ga'], includeGroups: true })).toBe(3);
    });
});

describe('/query search totals on a small set', () => {
    /** The total of a search request, as JSON (a number, or `~<number>` when approximate) or from the binary header. */
    async function searchTotal(body, binary) {
        const response = await postJson({ ...body, want: [binary ? 'hashes' : 'rows', 'total'] });
        expect(response.status).toBe(200);
        if (!binary) return (await response.json()).total;
        const view = new DataView(await response.arrayBuffer());
        const flags = view.getUint8(0);
        const total = view.getFloat64(1 + 1 + 8, true);
        return (flags & 0b10) !== 0 ? `~${total}` : total;
    }

    test('twelve matches give an exact total of 12 on every page, in every sort, with and without groups, JSON and binary', async () => {
        for (let i = 0; i < 12; i++) await seedCharacterWithFile(`zephyr${i}.png`, `Zephyr ${i}`);
        for (let i = 0; i < 3; i++) await seedCharacterWithFile(`other${i}.png`, `Other ${i}`);
        const sorts = [{ field: 'search' }, { field: 'name', order: 'asc' }, { field: 'date_added', order: 'desc' }];
        for (const sort of sorts) {
            for (const includeGroups of [false, true]) {
                for (const binary of [false, true]) {
                    for (const page of [1, 2, 3]) {
                        const total = await searchTotal({ filter: { search: 'zephyr', ...(includeGroups ? { includeGroups } : {}) }, sort, page, pageSize: 5 }, binary);
                        expect({ sort: sort.field, includeGroups, binary, page, total }).toEqual({ sort: sort.field, includeGroups, binary, page, total: 12 });
                    }
                }
            }
        }
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

    test('returns the same rows and totals, with and without groups, with and without a merged tag', async () => {
        await seedLibrary();
        const ids = ['a.png', 'b.png', 'c.png', 'd.png', 'ga', 'gb', 'gc'];
        expect(await query({ ids, tags: { exclude: ['t2'] } })).toEqual({ total: 2, rows: ['b.png', 'c.png'] });
        expect(await query({ ids, tags: { exclude: ['t1', 't2'] } })).toEqual({ total: 1, rows: ['c.png'] });
        expect(await query({ ids, tags: { include: ['t1'], exclude: ['t2'] }, includeGroups: true })).toEqual({ total: 2, rows: ['b.png', 'ga'] });
        expect(await query({ ids, tags: { exclude: ['t2'] }, includeGroups: true })).toEqual({ total: 4, rows: ['b.png', 'c.png', 'ga', 'gc'] });

        expect(await user.store.lib.tags.delete('t2', 't1')).toMatchObject({ refused: [] });
        expect(await query({ ids, tags: { exclude: ['t1'] }, includeGroups: true })).toEqual({ total: 2, rows: ['c.png', 'gc'] });
        expect(await query({ ids, tags: { exclude: ['t2'] } })).toEqual({ total: 1, rows: ['c.png'] });
    });
});
