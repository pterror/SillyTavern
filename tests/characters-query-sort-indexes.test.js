import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

// The order of /query pages: ties in creation order, through offset paging and cursors, over entities sharing sort keys.

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    fixture = await import('./converted-user.fixture.js');
});

beforeEach(async () => {
    user = await fixture.emptyUser('st-query-sort-indexes-test-');
    ({ directories } = user);
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

/**
 * Entities sharing sort keys, so the tie order decides most of the list. They are created in an order that is not
 * their ids' (b.png before a.png; group 'a' before 'a-b', whose file name 'a-b.json' sorts first); characters and
 * groups share keys.
 * `chat`: a chat of one message (all at one time), so these tie on date_last_chat and chat_size; the others have none.
 */
const CHARACTERS = [
    { id: 'b.png', name: 'Same', fav: true, date: 100, chat: true },
    { id: 'a.png', name: 'Same', fav: false, date: 100, chat: true },
    { id: 'c.png', name: 'Other', fav: false, date: 200, chat: false },
    { id: 'z.png', name: 'Same', fav: true, date: 50, chat: true },
    { id: 'm.png', name: 'Zed', fav: false, date: 100, chat: true, longer: true },
    { id: 'k.png', name: 'Same', fav: false, date: 100, chat: true, noCreateDate: true },
];
const GROUPS = [
    { id: 'a', name: 'Same', fav: false, date: 100, chat: true },
    { id: 'a-b', name: 'Same', fav: false, date: 100, chat: true },
    { id: 'q', name: 'Other', fav: true, date: 200, chat: false },
];

/** @type {{ type: string, id: string, name_fold: string, fav: boolean, date: number, lastChat: number, size: number, create_date: number | null, data_size: number | null }[]} */
let MODEL = [];

const message = (long) => ({ name: 'User', is_user: true, mes: long ? 'a longer message of this chat' : 'a message', send_date: 'x', extra: {} });

async function seed() {
    // The chats' messages are all received at one moment, so equal chats tie in time and size.
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
        for (const c of CHARACTERS) {
            const card = { name: c.name, ...(c.noCreateDate ? {} : { create_date: new Date(c.date).toISOString() }), data: { name: c.name, description: 'd', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } };
            await user.store.lib.writeCard(directories, c.id, JSON.stringify(card), { fav: c.fav, dateAdded: c.date });
            if (c.chat) await fixture.saveBranch(user.store, { avatar: c.id }, `chat ${c.id}`, [{}, message(c.longer)]);
        }
        for (const g of GROUPS) {
            await user.store.lib.writeGroup({ id: g.id, name: g.name, members: [], fav: g.fav }, { dateAdded: g.date });
            if (g.chat) await fixture.saveBranch(user.store, { group: g.id }, `chat ${g.id}`, [{}, message(false)]);
        }
    } finally {
        now.mockRestore();
    }
    // What the store holds for each: the sort keys the expected lists are made from.
    const page = await user.store.lib.query({ limit: 100, wantRows: true, wantTotal: false });
    MODEL = /** @type {any[]} */ (page.rows).map(({ type, item }) => (type === 'group'
        ? { type, id: item.id, name_fold: item.name.toLowerCase(), fav: item.fav, date: item.date_added, lastChat: item.date_last_chat, size: item.chat_size, create_date: item.date_added, data_size: null }
        : { type, id: item.avatar, name_fold: item.name.toLowerCase(), fav: item.fav, date: item.date_added, lastChat: item.date_last_chat, size: item.chat_size, create_date: item.create_date === undefined ? null : Date.parse(item.create_date), data_size: item.data_size }));
    expect(MODEL).toHaveLength(CHARACTERS.length + GROUPS.length);
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
 */
function expected(sortField, sortOrder, fav) {
    const dir = sortOrder === 'desc' ? -1 : 1;
    const entities = MODEL.filter(e => fav === undefined || e.fav === fav);
    const key = {
        name: e => e.name_fold, date_added: e => e.date, date_last_chat: e => e.lastChat, chat_size: e => e.size,
        create_date: e => e.create_date, data_size: e => e.data_size,
    }[sortField];
    // A missing key sorts below every number.
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

/** @param {object} params */
const idOf = r => `${r.type}:${r.type === 'group' ? r.item.id : r.item.avatar}`;

/** @param {object} params */
async function listed(params) {
    const result = await user.store.lib.query({ offset: 0, limit: 100, wantTotal: false, ...params });
    return result.rows.map(idOf);
}

const SORTS = ['name', 'fav', 'date_added', 'date_last_chat', 'chat_size', 'create_date', 'data_size'];
const FAVS = [undefined, true, false];

describe('/query sorted pages: ties in creation order', () => {
    test('every sort, direction and fav filter lists the same, and pages join up', async () => {
        await seed();
        for (const sortField of SORTS) {
            for (const sortOrder of ['asc', 'desc']) {
                for (const fav of FAVS) {
                    const want = expected(sortField, sortOrder, fav);
                    expect({ sortField, sortOrder, fav, rows: await listed({ sortField, sortOrder, fav }) })
                        .toEqual({ sortField, sortOrder, fav, rows: want });
                    const paged = [];
                    for (let offset = 0; offset < want.length; offset += 3) {
                        paged.push(...await listed({ sortField, sortOrder, fav, offset, limit: 3 }));
                    }
                    expect(paged).toEqual(want);
                }
            }
        }
    });

    test('following each page\'s cursor lists the same as paging by offset', async () => {
        await seed();
        for (const sortField of SORTS) {
            for (const sortOrder of ['asc', 'desc']) {
                for (const fav of FAVS) {
                    const want = expected(sortField, sortOrder, fav);
                    const followed = [];
                    let cursor;
                    for (let offset = 0; offset < want.length + 2; offset += 2) {
                        const result = await user.store.lib.query({ sortField, sortOrder, fav, offset, limit: 2, wantTotal: false, cursor });
                        followed.push(...result.rows.map(idOf));
                        cursor = result.cursor;
                        if (result.rows.length < 2) break;
                    }
                    expect({ sortField, sortOrder, fav, rows: followed }).toEqual({ sortField, sortOrder, fav, rows: want });
                }
            }
        }
    });

    test('a cursor carries on after its last row when rows are added before it, and one made for another sort is refused', async () => {
        await seed();
        const first = await user.store.lib.query({ sortField: 'name', sortOrder: 'asc', offset: 0, limit: 3, wantTotal: false });
        const seen = first.rows.map(idOf);
        // A new entity that sorts before the cursor would shift an offset page; the cursor isn't moved by it.
        const cardJson = JSON.stringify({ name: 'Aaa', data: { name: 'Aaa', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await user.store.lib.writeCard(directories, 'new.png', cardJson);
        const next = await user.store.lib.query({ sortField: 'name', sortOrder: 'asc', offset: 3, limit: 100, wantTotal: false, cursor: first.cursor });
        const rest = expected('name', 'asc', undefined).filter(e => !seen.includes(e));
        expect(next.rows.map(idOf)).toEqual(rest);
        for (const sort of [{ sortField: 'date_added', sortOrder: 'asc' }, { sortField: 'name', sortOrder: 'desc' }, { sortField: 'random', seed: 3 }]) {
            expect(await user.store.lib.query({ ...sort, offset: 0, limit: 100, wantTotal: false, cursor: first.cursor })).toBe('invalid-cursor');
        }
    });
});

describe('/query with characters only: the same walk, cursor and work cap', () => {
    /** @param {string} sortField @param {'asc'|'desc'} sortOrder @param {boolean | undefined} fav */
    const expectedCharacters = (sortField, sortOrder, fav) => expected(sortField, sortOrder, fav).filter(e => e.startsWith('character:')).map(e => e.slice('character:'.length));

    test('every sort, direction and fav filter lists in order, and following each page\'s cursor joins up', async () => {
        await seed();
        for (const sortField of SORTS) {
            for (const sortOrder of ['asc', 'desc']) {
                for (const fav of FAVS) {
                    const want = expectedCharacters(sortField, sortOrder, fav);
                    const all = await user.store.lib.query({ includeGroups: false, sortField, sortOrder, fav, offset: 0, limit: 100, wantTotal: false });
                    expect({ sortField, sortOrder, fav, rows: all.rows.map(r => r.item.avatar) }).toEqual({ sortField, sortOrder, fav, rows: want });
                    const followed = [];
                    const fullPagesWithoutCursor = [];
                    let cursor;
                    for (let offset = 0; offset < want.length + 2; offset += 2) {
                        const page = await user.store.lib.query({ includeGroups: false, sortField, sortOrder, fav, offset, limit: 2, wantTotal: false, cursor });
                        followed.push(...page.rows.map(r => r.item.avatar));
                        if (page.rows.length === 2 && typeof page.cursor !== 'string') fullPagesWithoutCursor.push(offset);
                        cursor = page.cursor;
                        if (page.rows.length < 2) break;
                    }
                    expect({ sortField, sortOrder, fav, rows: followed, fullPagesWithoutCursor }).toEqual({ sortField, sortOrder, fav, rows: want, fullPagesWithoutCursor: [] });
                }
            }
        }
    });

    test('past the work cap, a page answers `more` and a cursor, and following them lists everything once', async () => {
        await seed();
        {
            // The cap bounds what a page reads past its own rows: two characters left out next to each other (in
            // name order) are more than a cap of 1.
            const excludeIds = ['a.png', 'b.png'];
            const want = expectedCharacters('name', 'asc', undefined).filter(id => !excludeIds.includes(id));
            const followed = [];
            let cursor;
            let sawMore = false;
            for (let i = 0; i < 50; i++) {
                const page = await user.store.lib.query({ includeGroups: false, sortField: 'name', sortOrder: 'asc', excludeIds, offset: 0, limit: 1, wantTotal: false, cursor, cap: 1 });
                if (page.more) sawMore = true;
                followed.push(...page.rows.map(r => r.item.avatar));
                cursor = page.cursor;
                if (!page.more && page.rows.length < 1) break;
            }
            expect(sawMore).toBe(true);
            expect(followed).toEqual(want);
        }
    });

    test('hash rows come in the same order as rows', async () => {
        await seed();
        const result = await user.store.lib.query({ includeGroups: false, sortField: 'date_added', sortOrder: 'desc', offset: 0, limit: 100, wantTotal: false, wantRows: false, wantHashes: true });
        expect(result.hashRows.map(r => r.id)).toEqual(expectedCharacters('date_added', 'desc', undefined));
        expect(result.hashRows[0]).toHaveProperty('chat');
        expect(result.hashRows[0]).toEqual(expect.objectContaining({ version: expect.any(Number) }));
    });
});
