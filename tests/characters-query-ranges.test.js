import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('express').Router} */
let router;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    fixture = await import('./converted-user.fixture.js');
    ({ router } = await import('../src/endpoints/characters.js'));
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
    user = await fixture.emptyUser('st-query-ranges-test-');
    ({ directories } = user);
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

// Characters' and groups' dates are set; their data sizes and chats differ, and the ranges are read against the
// values the store holds for them (chat sizes and times come from the messages stored).
const CHARACTERS = Array.from({ length: 12 }, (_, i) => ({ id: `c${String(i).padStart(2, '0')}.png`, fav: i % 3 === 0, created: 1000 + i * 100, messages: i, dataSize: 50 + i * 5 }));
const GROUPS = Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, fav: i % 2 === 1, created: 1050 + i * 300, messages: i }));

/** @type {{ type: string, id: string, fav: boolean, created: number, lastChat: number, chatSize: number, dataSize?: number }[]} */
let ALL = [];

/** Stores the entities, then reads the values each now has: the model the ranges are checked against. */
async function seed() {
    for (const c of CHARACTERS) {
        const cardJson = JSON.stringify({
            name: c.id, create_date: new Date(c.created).toISOString(),
            data: { name: c.id, description: 'd'.repeat(c.dataSize), tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } },
        });
        await user.store.lib.writeCard(directories, c.id, cardJson, { fav: c.fav, dateAdded: c.created });
        if (c.messages > 0) await fixture.saveBranch(user.store, { avatar: c.id }, `chat ${c.id}`, [{}, ...Array.from({ length: c.messages }, (_, m) => ({ name: 'User', is_user: true, mes: `message ${m} `.repeat(m + 1), send_date: 'x', extra: {} }))]);
    }
    for (const g of GROUPS) {
        await user.store.lib.writeGroup({ id: g.id, name: g.id, members: [], fav: g.fav }, { dateAdded: g.created });
        if (g.messages > 0) await fixture.saveBranch(user.store, { group: g.id }, `chat ${g.id}`, [{}, ...Array.from({ length: g.messages }, (_, m) => ({ name: 'User', is_user: true, mes: `message ${m} `.repeat(m + 1), send_date: 'x', extra: {} }))]);
    }
    const page = await user.store.lib.query({ limit: 100, wantRows: true, wantTotal: false });
    ALL = /** @type {any[]} */ (page.rows).map(({ type, item }) => (type === 'group'
        ? { type, id: item.id, fav: item.fav, created: item.date_added, lastChat: item.date_last_chat, chatSize: item.chat_size }
        : { type, id: item.avatar, fav: item.fav, created: Date.parse(item.create_date), lastChat: item.date_last_chat, chatSize: item.chat_size, dataSize: item.data_size }));
    expect(ALL).toHaveLength(CHARACTERS.length + GROUPS.length);
}

/**
 * Whether an entity is inside `ranges`; a group has no data_size, so a bound on it leaves groups out.
 * @param {{ type: string, created: number, lastChat: number, chatSize: number, dataSize?: number }} e
 * @param {Record<string, { min?: number, max?: number }>} ranges
 */
function inRanges(e, ranges) {
    const value = { create_date: e.created, date_last_chat: e.lastChat, chat_size: e.chatSize, data_size: e.type === 'group' ? null : e.dataSize };
    return Object.entries(ranges).every(([field, { min, max }]) => value[field] !== null
        && (min === undefined || value[field] >= min) && (max === undefined || value[field] <= max));
}

/** A value of a field over the entities that have it, `at` of the way up. @param {(e: typeof ALL[number]) => number | undefined} get @param {number} at */
const quantile = (get, at) => {
    const values = ALL.map(get).filter(v => v !== undefined).sort((a, b) => a - b);
    return values[Math.floor(values.length * at)];
};
const median = get => quantile(get, 0.5);

/** Ranges that each leave some entities in and some out, from the seeded values. */
function rangesList() {
    return [
        { create_date: { min: 1300, max: 1900 } },
        { date_last_chat: { max: median(e => e.lastChat) } },
        { chat_size: { min: median(e => e.chatSize) } },
        { data_size: { min: quantile(e => e.dataSize, 0.25), max: quantile(e => e.dataSize, 0.75) } },
        { create_date: { min: 1100 }, chat_size: { max: median(e => e.chatSize) } },
    ];
}

/** @param {object} params */
async function listedSet(params) {
    const rows = [];
    for (let offset = 0; ; offset += 4) {
        const result = await user.store.lib.query({ offset, limit: 4, wantTotal: false, ...params });
        rows.push(...result.rows.map(r => `${r.type}:${r.type === 'group' ? r.item.id : r.item.avatar}`));
        if (result.rows.length < 4) break;
    }
    return rows;
}

describe('/query filter.ranges', () => {
    test('every sort and direction lists exactly the entities inside the ranges, paged', async () => {
        await seed();
        for (const ranges of rangesList()) {
            const want = ALL.filter(e => inRanges(e, ranges)).map(e => `${e.type}:${e.id}`).sort();
            expect(want.length).toBeGreaterThan(0);
            for (const sortField of ['name', 'create_date', 'date_last_chat', 'chat_size', 'data_size', 'fav']) {
                for (const sortOrder of ['asc', 'desc']) {
                    const rows = await listedSet({ ranges, sortField, sortOrder });
                    expect({ ranges, sortField, sortOrder, rows: [...rows].sort() }).toEqual({ ranges, sortField, sortOrder, rows: want });
                    expect(new Set(rows).size).toBe(rows.length);
                }
            }
        }
    });

    test('random order with ranges lists each entity inside them once', async () => {
        await seed();
        for (const ranges of rangesList()) {
            const want = ALL.filter(e => inRanges(e, ranges)).map(e => `${e.type}:${e.id}`).sort();
            const rows = await listedSet({ ranges, sortField: 'random', sortOrder: 'asc', seed: 7 });
            expect([...rows].sort()).toEqual(want);
            expect(new Set(rows).size).toBe(rows.length);
        }
    });

    test('ranges combine with fav, and the characters-only query applies them too', async () => {
        await seed();
        const ranges = { create_date: { min: 1100, max: 1800 } };
        const favWant = ALL.filter(e => e.fav && inRanges(e, ranges)).map(e => `${e.type}:${e.id}`).sort();
        expect((await listedSet({ ranges, fav: true, sortField: 'name', sortOrder: 'asc' })).sort()).toEqual(favWant);

        const result = await user.store.lib.query({ ranges, sortField: 'name', sortOrder: 'asc', offset: 0, limit: 100, wantTotal: true, includeGroups: false });
        const charsWant = ALL.filter(e => e.type === 'character' && inRanges(e, ranges)).map(e => e.id).sort();
        expect(result.rows.map(r => r.item.avatar).sort()).toEqual(charsWant);
    });

    test('the total of a ranged query is right, whether counted or estimated', async () => {
        await seed();
        const ranges = { chat_size: { min: median(e => e.chatSize) } };
        const result = await user.store.lib.query({ ranges, offset: 0, limit: 2, wantTotal: true });
        const want = ALL.filter(e => inRanges(e, ranges)).length;
        expect(result.total).toBe(want);
    });

    test('the route checks filter.ranges: unknown fields and non-numbers are refused, empty bounds mean no filter', async () => {
        await seed();
        const post = body => fetch(`${baseUrl}/api/characters/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

        expect((await post({ filter: { ranges: { name: { min: 1 } } } })).status).toBe(400);
        expect((await post({ filter: { ranges: { chat_size: { min: 'a lot' } } } })).status).toBe(400);
        expect((await post({ filter: { ranges: [] } })).status).toBe(400);

        const min = median(e => e.chatSize);
        const ok = await post({ filter: { ranges: { chat_size: { min } }, includeGroups: true }, sort: { field: 'name', order: 'asc' }, pageSize: 100 });
        expect(ok.status).toBe(200);
        const body = await ok.json();
        const want = ALL.filter(e => inRanges(e, { chat_size: { min } })).length;
        expect(body.rows).toHaveLength(want);

        const empty = await post({ filter: { ranges: { chat_size: {} }, includeGroups: true }, sort: { field: 'name', order: 'asc' }, pageSize: 100 });
        expect((await empty.json()).rows).toHaveLength(ALL.length);
    });
});
