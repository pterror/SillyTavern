import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

// /query with included and excluded tags: the same lists as the plain rule gives, through every sort, direction and
// fav filter, by offset pages and by cursor.

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
let TYPE;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    fixture = await import('./converted-user.fixture.js');
    ({ TYPE } = await import('../src/library-codes.js'));
});

beforeEach(async () => {
    user = await fixture.emptyUser('st-query-tag-sort-test-');
    ({ directories } = user);
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

// Entities with sort keys that tie, and tags: T1 on most, T2 on some, T3 on few.
const CHARACTERS = [
    { id: 'b.png', name: 'Same', fav: true, date: 100, chat: true, tags: ['T1', 'T2'] },
    { id: 'a.png', name: 'Same', fav: false, date: 100, chat: true, tags: ['T1'] },
    { id: 'c.png', name: 'Other', fav: false, date: 200, chat: false, tags: ['T1', 'T2', 'T3'] },
    { id: 'z.png', name: 'Same', fav: true, date: 50, chat: true, tags: ['T2'] },
    { id: 'm.png', name: 'Zed', fav: false, date: 100, chat: true, tags: ['T1', 'T3'] },
    { id: 'n.png', name: 'Alpha', fav: false, date: 300, chat: false, tags: [] },
];
const GROUPS = [
    { id: 'a', name: 'Same', fav: false, date: 100, chat: true, tags: ['T1'] },
    { id: 'a-b', name: 'Same', fav: false, date: 100, chat: true, tags: ['T1', 'T2'] },
    { id: 'q', name: 'Other', fav: true, date: 200, chat: false, tags: ['T2'] },
];

/** @type {{ type: string, id: string, name_fold: string, fav: boolean, date: number, lastChat: number, size: number, create_date: number | null, data_size: number | null, tags: string[] }[]} */
let MODEL = [];

const message = { name: 'User', is_user: true, mes: 'a message', send_date: 'x', extra: {} };

async function seed() {
    for (const t of ['T1', 'T2', 'T3']) await user.store.lib.writeTag({ id: t, name: t });
    // The chats' messages are all received at one moment, so equal chats tie in time and size.
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
        for (const c of CHARACTERS) {
            const card = { name: c.name, create_date: new Date(c.date).toISOString(), data: { name: c.name, description: 'd', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } };
            await user.store.lib.writeCard(directories, c.id, JSON.stringify(card), { fav: c.fav, dateAdded: c.date });
            if (c.chat) await fixture.saveBranch(user.store, { avatar: c.id }, `chat ${c.id}`, [{}, message]);
            for (const t of c.tags) await user.store.lib.assignTag(TYPE.character, c.id, t, true);
        }
        for (const g of GROUPS) {
            await user.store.lib.writeGroup({ id: g.id, name: g.name, members: [], fav: g.fav }, { dateAdded: g.date });
            if (g.chat) await fixture.saveBranch(user.store, { group: g.id }, `chat ${g.id}`, [{}, message]);
            for (const t of g.tags) await user.store.lib.assignTag(TYPE.group, g.id, t, true);
        }
    } finally {
        now.mockRestore();
    }
    await readModel();
}

/** Reads what the store holds for each entity: the sort keys and tags the expected lists are made from. */
async function readModel() {
    const page = await user.store.lib.query({ limit: 100, wantRows: true, wantTotal: false });
    MODEL = /** @type {any[]} */ (page.rows).map(({ type, item }) => (type === 'group'
        ? { type, id: item.id, name_fold: item.name.toLowerCase(), fav: item.fav, date: item.date_added, lastChat: item.date_last_chat, size: item.chat_size, create_date: item.date_added, data_size: null, tags: item.tag_ids }
        : { type, id: item.avatar, name_fold: item.name.toLowerCase(), fav: item.fav, date: item.date_added, lastChat: item.date_last_chat, size: item.chat_size, create_date: item.create_date === undefined ? null : Date.parse(item.create_date), data_size: item.data_size, tags: item.tag_ids }));
}

/** UTF-8 byte order, as SQLite's BINARY collation. */
const bytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * The expected list, from the rule itself: ascending, the sort key, then characters before groups, then creation
 * order (the engine's orders break ties by entity id, not by upstream's avatar or `<id>.json`); descending, that list
 * reversed. A fav sort only picks which fav value
 * comes first, with names and ties ascending inside each.
 * @param {string} sortField
 * @param {'asc'|'desc'} sortOrder
 * @param {boolean | undefined} fav
 * @param {{ include?: string[], exclude?: string[] }} tags
 */
function expected(sortField, sortOrder, fav, tags) {
    const dir = sortOrder === 'desc' ? -1 : 1;
    const entities = MODEL.filter(e => (fav === undefined || e.fav === fav)
        && (tags.include ?? []).every(t => e.tags.includes(t)) && !(tags.exclude ?? []).some(t => e.tags.includes(t)));
    const key = {
        name: e => e.name_fold, date_added: e => e.date, date_last_chat: e => e.lastChat, chat_size: e => e.size,
        create_date: e => e.create_date, data_size: e => e.data_size,
    }[sortField];
    const byNumber = (ka, kb) => (ka === null || kb === null) ? (ka === kb ? 0 : ka === null ? -1 : 1) : ka - kb;
    // Seeded characters first, then groups, each in list order: the order they were created in.
    const created = e => (e.type === 'group' ? CHARACTERS.length + GROUPS.findIndex(g => g.id === e.id) : CHARACTERS.findIndex(c => c.id === e.id));
    const tie = (a, b) => (a.type === b.type ? 0 : a.type === 'group' ? 1 : -1) || created(a) - created(b);
    return [...entities].sort((a, b) => {
        if (sortField === 'fav') return dir * (Number(a.fav) - Number(b.fav)) || bytes(a.name_fold, b.name_fold) || tie(a, b);
        const ka = key(a), kb = key(b);
        const byKey = typeof ka === 'string' ? bytes(ka, kb) : byNumber(ka, kb);
        return dir * (byKey || tie(a, b));
    }).map(e => `${e.type}:${e.id}`);
}

const idOf = r => `${r.type}:${r.type === 'group' ? r.item.id : r.item.avatar}`;

/** @param {object} params */
async function listed(params) {
    const result = await user.store.lib.query({ offset: 0, limit: 100, wantTotal: false, ...params });
    return result.rows.map(idOf);
}

const SORTS = ['name', 'fav', 'date_added', 'date_last_chat', 'chat_size', 'create_date', 'data_size'];
const FILTERS = [
    { include: ['T1'] },
    { include: ['T2'] },
    { include: ['T1', 'T2'] },
    { include: ['T1', 'T3'] },
    { include: ['T1'], exclude: ['T3'] },
    { include: ['T1', 'T2'], exclude: ['T3'] },
];

/** Every combination's list, as `/query` gives it, with the rule's. */
async function everyList() {
    const out = [];
    for (const sortField of SORTS) {
        for (const sortOrder of ['asc', 'desc']) {
            for (const fav of [undefined, true, false]) {
                for (const tags of FILTERS) {
                    out.push({
                        sortField, sortOrder, fav, tags,
                        rows: await listed({ sortField, sortOrder, fav, tags: { mode: 'and', ...tags } }),
                        want: expected(sortField, sortOrder, fav, tags),
                    });
                }
            }
        }
    }
    return out;
}

describe('/query included and excluded tags', () => {
    test('every sort, direction, fav filter and tag filter lists exactly as the rule does', async () => {
        await seed();
        const lists = await everyList();
        expect(lists.some(l => l.rows.length > 0)).toBe(true);
        for (const { rows, want, ...which } of lists) expect({ ...which, rows }).toEqual({ ...which, rows: want });
    });

    test('pages join up to the whole list', async () => {
        await seed();
        for (const sortField of ['name', 'date_added', 'fav']) {
            for (const sortOrder of ['asc', 'desc']) {
                const tags = { mode: 'and', include: ['T1'] };
                const whole = await listed({ sortField, sortOrder, tags });
                const paged = [];
                for (let offset = 0; offset < whole.length; offset += 2) paged.push(...await listed({ sortField, sortOrder, tags, offset, limit: 2 }));
                expect(paged).toEqual(whole);
            }
        }
    });

    test('the lists stay right through tag, sort key, fav, insert and delete writes', async () => {
        await seed();
        const lib = user.store.lib;
        await lib.writeCard(directories, 'm.png', JSON.stringify({ name: 'Zed', create_date: new Date(1).toISOString(), data: { name: 'Zed', description: 'd', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } }));
        await lib.updateEntity(TYPE.character, 'm.png', { dateAdded: 1 });
        await lib.setFav(TYPE.character, 'm.png', true);
        await lib.assignTag(TYPE.character, 'b.png', 'T1', false);
        await lib.assignTag(TYPE.character, 'n.png', 'T1', true);
        await lib.updateEntity(TYPE.group, 'a', { dateAdded: 999 });
        await lib.deleteEntity(TYPE.group, 'a-b');
        await readModel();
        expect(MODEL).toHaveLength(CHARACTERS.length + GROUPS.length - 1);
        for (const { rows, want, ...which } of await everyList()) expect({ ...which, rows }).toEqual({ ...which, rows: want });
    });

    test('an excluded tag leaves out the right entities, with or without an included one', async () => {
        await seed();
        for (const tags of [{ exclude: ['T3'] }, { include: ['T1'], exclude: ['T3'] }]) {
            const rows = await listed({ sortField: 'name', sortOrder: 'asc', tags: { mode: 'and', ...tags } });
            const want = [...CHARACTERS.map(c => ({ ...c, type: 'character' })), ...GROUPS.map(g => ({ ...g, type: 'group' }))]
                .filter(e => !e.tags.includes('T3') && (tags.include ?? []).every(t => e.tags.includes(t)))
                .map(e => `${e.type}:${e.id}`);
            expect(new Set(rows)).toEqual(new Set(want));
        }
    });

    test('under the work cap, a page that needs more reading comes back with more and a cursor, and following it lists everything once', async () => {
        await seed();
        {
            // The cap bounds what a page reads past its own rows: only a list that leaves entities out can reach it.
            const reachedCap = new Set();
            for (const tags of [{ include: ['T1'], exclude: ['T3'] }, { include: ['T1', 'T2'] }, { exclude: ['T3'] }, {}]) {
                for (const sortOrder of ['asc', 'desc']) {
                    const filter = { sortField: 'name', sortOrder, tags: { mode: 'and', ...tags } };
                    const whole = await listed(filter);
                    // As the client does: ask for a page, follow `more` with the cursor until it's full or ends.
                    for (const pageSize of [2, 3]) {
                        const followed = [];
                        let cursor;
                        let sawMore = false;
                        for (let requests = 0; requests < 200; requests++) {
                            const result = await user.store.lib.query({ ...filter, offset: followed.length, limit: pageSize, wantTotal: false, cursor, cap: 1 });
                            followed.push(...result.rows.map(idOf));
                            sawMore ||= result.more === true;
                            cursor = result.cursor;
                            if (result.more !== true && result.rows.length < pageSize) break;
                        }
                        expect({ tags, sortOrder, pageSize, rows: followed }).toEqual({ tags, sortOrder, pageSize, rows: whole });
                        if (sawMore) reachedCap.add(JSON.stringify(tags));
                    }
                }
            }
            expect(reachedCap.size).toBeGreaterThan(0);
            expect(reachedCap.has(JSON.stringify({}))).toBe(false);
        }
    });

    test('a jump past the cap with no cursor answers an empty page with more, and following it reaches the asked page', async () => {
        await seed();
        const whole = await listed({ sortField: 'date_added', sortOrder: 'desc' });
        {
            const offset = 6;
            let result = await user.store.lib.query({ sortField: 'date_added', sortOrder: 'desc', offset, limit: 2, wantTotal: false, cap: 1 });
            expect(result.rows).toEqual([]);
            expect(result.more).toBe(true);
            const rows = [];
            for (let requests = 0; requests < 100 && result.more === true && rows.length < 2; requests++) {
                result = await user.store.lib.query({ sortField: 'date_added', sortOrder: 'desc', offset, limit: 2 - rows.length, wantTotal: false, cursor: result.cursor, cap: 1 });
                rows.push(...result.rows.map(idOf));
            }
            expect(rows).toEqual(whole.slice(offset, offset + 2));
        }
    });
});
