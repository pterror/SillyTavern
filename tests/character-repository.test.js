import { describe, test, expect, jest, beforeEach } from '@jest/globals';

const getRequestHeadersMock = jest.fn(() => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }));
const unshallowCharacterMock = jest.fn();

// character-repository.js imports these from '../script.js' (it lives in public/scripts/) - script.js itself
// is not safely importable in a plain node test env (jQuery/DOM assumptions throughout), so it's mocked at the
// module boundary, same pattern as tests/search-visit.test.js uses for node-fetch. `charactersStore` is also
// exported here so the module's own default-constructed `characterRepository` singleton doesn't blow up on
// import, but every test below constructs its own `CharacterRepository` against a fresh fake store instead of
// relying on that singleton, to keep tests isolated from each other.
jest.unstable_mockModule('../public/script.js', () => ({
    charactersStore: { get: () => undefined, has: () => false, onChange: () => () => {} },
    getRequestHeaders: getRequestHeadersMock,
    unshallowCharacter: unshallowCharacterMock,
}));

/** @type {typeof import('../public/scripts/character-repository.js').CharacterRepository} */
let CharacterRepository;
/** @type {typeof import('../public/scripts/character-repository.js').buildCharacterQuery} */
let buildCharacterQuery;
/** @type {typeof import('../public/scripts/character-repository.js').isServerQueryableSort} */
let isServerQueryableSort;
/** @type {typeof import('../public/scripts/character-repository.js').normalizeQueryRow} */
let normalizeQueryRow;

beforeAll(async () => {
    ({ CharacterRepository, buildCharacterQuery, isServerQueryableSort, normalizeQueryRow } = await import('../public/scripts/character-repository.js'));
});

/** Minimal fake of the EntityStore surface CharacterRepository actually uses. */
function makeStore(initial = []) {
    const byId = new Map(initial.map(c => [c.avatar, c]));
    const listeners = new Set();
    return {
        byId,
        get: jest.fn(id => byId.get(id)),
        has: jest.fn(id => byId.has(id)),
        onChange: jest.fn(fn => { listeners.add(fn); return () => listeners.delete(fn); }),
        _emit: change => listeners.forEach(fn => fn(change)),
    };
}

beforeEach(() => {
    getRequestHeadersMock.mockClear();
    unshallowCharacterMock.mockReset();
    global.fetch = jest.fn();
});

describe('peek()', () => {
    test('returns the resident row synchronously, never fetching', () => {
        const alice = { avatar: 'alice', name: 'Alice' };
        const store = makeStore([alice]);
        const repo = new CharacterRepository(store);

        expect(repo.peek('alice')).toBe(alice);
        expect(repo.peek('missing')).toBeUndefined();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('get()', () => {
    test('resolves from the resident store without a network call', async () => {
        const alice = { avatar: 'alice', name: 'Alice' };
        const store = makeStore([alice]);
        const repo = new CharacterRepository(store);

        await expect(repo.get('alice')).resolves.toBe(alice);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('falls back to a /query filter.ids call for a non-resident id, and does not write it into the store', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        const bob = { avatar: 'bob', name: 'Bob' };
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ rows: [bob], total: 1, rev: 7 }),
        });

        const result = await repo.get('bob');

        expect(result).toEqual(bob);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('/api/characters/query');
        const body = JSON.parse(init.body);
        expect(body.filter).toEqual({ ids: ['bob'] });
        expect(body.want).toEqual(['rows']);
        // The deliberate non-caching behavior (see get()'s doc comment): a server-fallback fetch must never
        // silently grow the resident store, since call sites elsewhere treat its size as "the boot-loaded
        // library" (design doc §4.1's "N hidden" badge).
        expect(store.get).not.toHaveBeenCalledWith('bob', expect.anything());
        expect(store.byId.has('bob')).toBe(false);
    });

    test('returns undefined for an id that resolves to no rows (a true miss, not merely non-resident)', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        global.fetch.mockResolvedValue({ ok: true, json: async () => ({ rows: [], total: 0, rev: 1 }) });

        await expect(repo.get('ghost')).resolves.toBeUndefined();
    });
});

describe('getMany()', () => {
    test('splits resident vs non-resident and only fetches the missing ones, in one batched call', async () => {
        const alice = { avatar: 'alice', name: 'Alice' };
        const store = makeStore([alice]);
        const repo = new CharacterRepository(store);
        const bob = { avatar: 'bob', name: 'Bob' };
        const carol = { avatar: 'carol', name: 'Carol' };
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ rows: [bob, carol], total: 2, rev: 3 }),
        });

        const result = await repo.getMany(['alice', 'bob', 'carol']);

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.filter.ids).toEqual(['bob', 'carol']);
        expect(result.get('alice')).toBe(alice);
        expect(result.get('bob')).toEqual(bob);
        expect(result.get('carol')).toEqual(carol);
        expect(result.size).toBe(3);
    });

    test('skips the network call entirely when every id is already resident', async () => {
        const alice = { avatar: 'alice' };
        const bob = { avatar: 'bob' };
        const store = makeStore([alice, bob]);
        const repo = new CharacterRepository(store);

        const result = await repo.getMany(['alice', 'bob']);

        expect(global.fetch).not.toHaveBeenCalled();
        expect(result.size).toBe(2);
    });

    test('ids that fail to resolve server-side are simply absent from the result map (exists()-style semantics)', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        global.fetch.mockResolvedValue({ ok: true, json: async () => ({ rows: [], total: 0, rev: 1 }) });

        const result = await repo.getMany(['ghost']);

        expect(result.has('ghost')).toBe(false);
        expect(result.size).toBe(0);
    });
});

describe('full()', () => {
    test('delegates to unshallowCharacter() for a resident id and returns the (now-hydrated) resident entity', async () => {
        const alice = { avatar: 'alice', shallow: true };
        const store = makeStore([alice]);
        const repo = new CharacterRepository(store);
        unshallowCharacterMock.mockImplementation(async (id) => {
            // Simulate unshallowCharacter's real effect: mutates the resident entity in place.
            if (id === 'alice') Object.assign(alice, { shallow: false, description: 'hydrated' });
        });

        const result = await repo.full('alice');

        expect(unshallowCharacterMock).toHaveBeenCalledWith('alice');
        expect(result).toBe(alice);
        expect(result.description).toBe('hydrated');
    });

    test('throws a descriptive error for a non-resident id instead of silently returning undefined', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);

        await expect(repo.full('ghost')).rejects.toThrow(/entry-level fault-in/);
        expect(unshallowCharacterMock).not.toHaveBeenCalled();
    });
});

describe('query()', () => {
    test('posts the filter/sort/page/pageSize/want shape and returns the response verbatim', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        const responseBody = { rows: [{ avatar: 'a' }], total: 1, rev: 5, searchBackend: 'tantivy' };
        global.fetch.mockResolvedValue({ ok: true, json: async () => responseBody });

        const filter = { search: 'tsundere', fav: true };
        const sort = { field: 'random', seed: 42 };
        const result = await repo.query(filter, sort, 2, 50, ['rows', 'total']);

        expect(result).toEqual(responseBody);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('/api/characters/query');
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual(getRequestHeadersMock());
        expect(JSON.parse(init.body)).toEqual({
            filter, sort, page: 2, pageSize: 50, want: ['rows', 'total'],
        });
    });

    test('passes an approximate (~-prefixed) total through unchanged, never coercing it to a number', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        global.fetch.mockResolvedValue({ ok: true, json: async () => ({ rows: [], total: '~12345', rev: 9 }) });

        const result = await repo.query({}, { field: 'name', order: 'asc' }, 1, 100);

        expect(result.total).toBe('~12345');
        expect(typeof result.total).toBe('string');
    });

    test('defaults page/pageSize/want when not supplied', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        global.fetch.mockResolvedValue({ ok: true, json: async () => ({ rows: [], total: 0, rev: 0 }) });

        await repo.query({ fav: true });

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.page).toBe(1);
        expect(body.pageSize).toBe(100);
        expect(body.want).toEqual(['rows', 'total']);
    });

    test('rejects with a descriptive error on a non-ok response', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        global.fetch.mockResolvedValue({
            ok: false,
            status: 400,
            json: async () => ({ error: true, reason: 'invalid-sort-field' }),
        });

        await expect(repo.query({}, { field: 'bogus' })).rejects.toThrow(/400/);
    });
});

describe('exists()', () => {
    test('posts ids to /api/characters/exists and returns the response verbatim, without client-side chunking', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        const ids = ['a', 'b', 'c'];
        global.fetch.mockResolvedValue({ ok: true, json: async () => ({ a: true, b: false, c: true }) });

        const result = await repo.exists(ids);

        expect(result).toEqual({ a: true, b: false, c: true });
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('/api/characters/exists');
        expect(JSON.parse(init.body)).toEqual({ ids });
    });
});

describe('onChange()', () => {
    test('delegates straight to the backing store', () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        const listener = jest.fn();

        const unsubscribe = repo.onChange(listener);
        store._emit({ op: 'reset' });
        expect(listener).toHaveBeenCalledWith({ op: 'reset' });

        unsubscribe();
        listener.mockClear();
        store._emit({ op: 'reset' });
        expect(listener).not.toHaveBeenCalled();
    });
});

describe('queryAll()', () => {
    test('returns everything in one call when the first page is short', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        const rows = [{ avatar: 'a' }, { avatar: 'b' }];
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ rows, rev: 1 }) });

        const result = await repo.queryAll({ fav: true }, { field: 'name' });

        expect(result).toEqual(rows);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [, init] = global.fetch.mock.calls[0];
        expect(JSON.parse(init.body)).toMatchObject({ filter: { fav: true }, sort: { field: 'name' }, page: 1 });
    });

    test('loops pages until a short page terminates it, never trusting an approximate total to stop early', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        // Page size is the server's MAX_QUERY_PAGE_SIZE (2000), duplicated in character-repository.js as
        // QUERY_ALL_PAGE_SIZE - a full first page must not be treated as "the whole result", even with an
        // approximate ('~'-prefixed) total that looks like it might already cover everything.
        const fullPage = Array.from({ length: 2000 }, (_, i) => ({ avatar: `c${i}` }));
        const shortPage = [{ avatar: 'last' }];
        global.fetch = jest.fn()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ rows: fullPage, rev: 1, total: '~2001' }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ rows: shortPage, rev: 1 }) });

        const result = await repo.queryAll();

        expect(result).toHaveLength(2001);
        expect(global.fetch).toHaveBeenCalledTimes(2);
        const secondCallBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        expect(secondCallBody.page).toBe(2);
    });

    test('an empty result set makes exactly one call and returns an empty array', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ rows: [], rev: 1, total: 0 }) });

        const result = await repo.queryAll({ ids: [] });

        expect(result).toEqual([]);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});

describe('buildCharacterQuery()', () => {
    test('an empty/default call produces an empty filter and no sort', () => {
        expect(buildCharacterQuery()).toEqual({ filter: {}, sort: undefined });
    });

    test('maps a search term into filter.search', () => {
        const { filter } = buildCharacterQuery({ searchTerm: 'aria' });
        expect(filter).toEqual({ search: 'aria' });
    });

    test('maps tag include/exclude into filter.tags with mode "and" - matching the pre-existing local tagFilter() AND logic (filters.js)', () => {
        const { filter } = buildCharacterQuery({ tagsInclude: ['t1', 't2'], tagsExclude: ['t3'] });
        expect(filter.tags).toEqual({ include: ['t1', 't2'], exclude: ['t3'], mode: 'and' });
    });

    test('omits filter.tags entirely when both tag arrays are empty', () => {
        const { filter } = buildCharacterQuery({ tagsInclude: [], tagsExclude: [] });
        expect(filter.tags).toBeUndefined();
    });

    test('maps fav true/false through, and omits it when undefined (no fav filter active)', () => {
        expect(buildCharacterQuery({ fav: true }).filter.fav).toBe(true);
        expect(buildCharacterQuery({ fav: false }).filter.fav).toBe(false);
        expect(buildCharacterQuery({}).filter.fav).toBeUndefined();
    });

    test('maps a plain sort field/order', () => {
        const { sort } = buildCharacterQuery({ sortField: 'chat_size', sortOrder: 'desc' });
        expect(sort).toEqual({ field: 'chat_size', order: 'desc' });
    });

    test('defaults sortOrder to "asc" for a non-"desc" value when a sort field is given', () => {
        const { sort } = buildCharacterQuery({ sortField: 'name' });
        expect(sort).toEqual({ field: 'name', order: 'asc' });
    });

    test('maps sortField "random" with a seed, per design doc §5.3', () => {
        const { sort } = buildCharacterQuery({ sortField: 'random', sortOrder: 'asc', randomSeed: 42 });
        expect(sort).toEqual({ field: 'random', order: 'asc', seed: 42 });
    });

    test('a full combined call shapes filter and sort together', () => {
        const { filter, sort } = buildCharacterQuery({
            searchTerm: 'kobold',
            tagsInclude: ['fantasy'],
            tagsExclude: [],
            fav: true,
            sortField: 'date_last_chat',
            sortOrder: 'desc',
        });
        expect(filter).toEqual({ search: 'kobold', tags: { include: ['fantasy'], exclude: [], mode: 'and' }, fav: true });
        expect(sort).toEqual({ field: 'date_last_chat', order: 'desc' });
    });
});

describe('buildCharacterQuery() includeGroups', () => {
    test('omits filter.includeGroups by default - every pre-existing caller keeps working unmodified', () => {
        const { filter } = buildCharacterQuery({ fav: true });
        expect(filter).not.toHaveProperty('includeGroups');
    });

    test('sets filter.includeGroups: true only when explicitly requested', () => {
        const { filter } = buildCharacterQuery({ includeGroups: true });
        expect(filter.includeGroups).toBe(true);
    });

    test('composes with tag filters (folder-open + includeGroups, design doc §5 group_tags)', () => {
        const { filter } = buildCharacterQuery({ tagsInclude: ['folder-1'], includeGroups: true });
        expect(filter).toEqual({
            tags: { include: ['folder-1'], exclude: [], mode: 'and' },
            includeGroups: true,
        });
    });
});

describe('normalizeQueryRow()', () => {
    test('wraps a bare Character row (the filter.includeGroups: false/omitted shape) as type "character"', () => {
        const alice = { avatar: 'alice', name: 'Alice' };
        expect(normalizeQueryRow(alice)).toEqual({ type: 'character', item: alice });
    });

    test('passes an already-tagged character row through unchanged', () => {
        const row = { type: 'character', item: { avatar: 'alice' } };
        expect(normalizeQueryRow(row)).toEqual(row);
        expect(normalizeQueryRow(row)).toBe(row);
    });

    test('passes an already-tagged group row through unchanged', () => {
        const row = { type: 'group', item: { id: 'group-1', name: 'The Party' } };
        expect(normalizeQueryRow(row)).toEqual(row);
        expect(normalizeQueryRow(row)).toBe(row);
    });

    test('does not mistake a bare Character that happens to have a "type" field for a tagged row (no "item" key)', () => {
        const weirdCharacter = { avatar: 'alice', type: 'character' };
        expect(normalizeQueryRow(weirdCharacter)).toEqual({ type: 'character', item: weirdCharacter });
    });
});

describe('query()/queryAll() with includeGroups', () => {
    test('query() forwards filter.includeGroups verbatim and returns the tagged-row response untouched', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        const responseBody = {
            rows: [
                { type: 'character', item: { avatar: 'alice' } },
                { type: 'group', item: { id: 'group-1' } },
            ],
            total: 2,
            rev: 1,
        };
        global.fetch.mockResolvedValue({ ok: true, json: async () => responseBody });

        const result = await repo.query({ includeGroups: true }, { field: 'name', order: 'asc' }, 1, 50);

        expect(result).toEqual(responseBody);
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.filter).toEqual({ includeGroups: true });
    });

    test('queryAll() loops the tagged-row shape the same way it loops bare Character[] pages', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        const rows = [
            { type: 'character', item: { avatar: 'a' } },
            { type: 'group', item: { id: 'g1' } },
        ];
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ rows, rev: 1 }) });

        const result = await repo.queryAll({ includeGroups: true }, { field: 'name' });

        expect(result).toEqual(rows);
    });
});

describe('isServerQueryableSort()', () => {
    test('accepts every column /query can actually sort by (src/character-metadata-db.js QUERYABLE_SORT_COLUMNS)', () => {
        for (const field of ['name', 'date_last_chat', 'chat_size', 'fav']) {
            expect(isServerQueryableSort(field)).toBe(true);
        }
    });

    test('accepts "random" unconditionally (a seed is checked separately by the caller)', () => {
        expect(isServerQueryableSort('random')).toBe(true);
    });

    test('rejects "create_date" - a different field than the server\'s date_added column (character-repository.js doc comment)', () => {
        expect(isServerQueryableSort('create_date')).toBe(false);
    });

    test('rejects "data_size" - no server column exists for it at all', () => {
        expect(isServerQueryableSort('data_size')).toBe(false);
    });

    test('rejects "search" - relevance order needs an id list from the search index, not a plain column', () => {
        expect(isServerQueryableSort('search')).toBe(false);
    });

    test('rejects undefined/unknown fields', () => {
        expect(isServerQueryableSort(undefined)).toBe(false);
        expect(isServerQueryableSort('made_up_field')).toBe(false);
    });
});
