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

beforeAll(async () => {
    ({ CharacterRepository } = await import('../public/scripts/character-repository.js'));
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
