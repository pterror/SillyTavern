import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import {
    characterDigestFavHash, characterDigestFieldsHash, characterDigestTagIdsHash,
    groupDigestFavHash, groupDigestTagIdsHash, groupDigestContentHash, shallowCharacterData,
} from '../public/scripts/hash-utils.js';

const getRequestHeadersMock = jest.fn(() => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }));
const unshallowCharacterMock = jest.fn();

// HASH_VERSION / GROUP_HASH_VERSION in character-cache.js (not exported).
const CHARACTER_HASH_VERSION = 2;
const GROUP_HASH_VERSION = 1;

/** Same hashes saveCachedCharacters() stores, and the server ships as a character row's favHash/tagIdsHash/contentHash. */
function characterHashes(character) {
    return {
        fav: characterDigestFavHash(character) % 4294967296,
        tagIds: characterDigestTagIdsHash(character),
        content: characterDigestFieldsHash(character) % 4294967296,
    };
}

/** Same hashes saveCachedGroups() stores, and the server ships as a group row's hashes. */
function groupHashes(group) {
    return {
        fav: groupDigestFavHash(group),
        tagIds: groupDigestTagIdsHash(group),
        content: groupDigestContentHash(group),
    };
}

/**
 * In-memory stand-in for both character-cache.js IndexedDB stores. Records are structured-cloned in and out,
 * as IndexedDB does.
 * @type {Map<string, {character?: object, group?: object, hashes: {fav: number, tagIds: number, content: number, v: number}}>}
 */
let cacheRecords = new Map();

async function getCachedEntriesByIdsFake(ids) {
    const result = new Map();
    for (const id of ids) {
        const record = cacheRecords.get(id);
        if (record?.character && record.hashes.v === CHARACTER_HASH_VERSION) result.set(id, structuredClone(record));
    }
    return result;
}

async function saveCachedCharactersFake(entries) {
    for (const { avatar, character } of entries) {
        cacheRecords.set(avatar, structuredClone({ character, hashes: { ...characterHashes(character), v: CHARACTER_HASH_VERSION } }));
    }
    return [];
}

async function getCachedGroupEntriesByIdsFake(ids) {
    const result = new Map();
    for (const id of ids) {
        const record = cacheRecords.get(id);
        if (record?.group && record.hashes.v === GROUP_HASH_VERSION) result.set(id, structuredClone(record));
    }
    return result;
}

async function saveCachedGroupsFake(entries) {
    for (const { id, group } of entries) {
        cacheRecords.set(id, structuredClone({ group, hashes: { ...groupHashes(group), v: GROUP_HASH_VERSION } }));
    }
    return [];
}

// HASH_QUERY_SEARCH_BACKEND_CODES in src/endpoints/characters.js.
const SEARCH_BACKEND_CODES = { tantivy: 1, native: 2, wasm: 3, unavailable: 4 };

/**
 * Mirrors serializeQueryHashesBinary() in src/endpoints/characters.js byte for byte (it isn't exported).
 * @param {{seq:number, token:string|null, total:number|undefined, approxTotal:boolean, hashRows:object[], searchBackend?:string}} params
 * @returns {ArrayBuffer}
 */
function encodeQueryHashes({ seq, token, total, approxTotal, hashRows, searchBackend }) {
    const hasTotal = typeof total === 'number';
    const searchBackendCode = SEARCH_BACKEND_CODES[searchBackend] ?? 0;

    let totalSize = 1 + 1 + 8 + 8 + 2;
    for (const row of hashRows) {
        const idBytes = Buffer.byteLength(row.id, 'utf8');
        const chatBytes = row.chat ? Buffer.byteLength(row.chat, 'utf8') : 0;
        totalSize += 1 + 2 + idBytes + 4 + 4 + 4 + 8 + 8 + 8 + 8 + 8 + 2 + chatBytes;
    }
    const tokenBytes = token ? Buffer.byteLength(token, 'utf8') : 0;
    totalSize += 2 + tokenBytes;

    const buf = Buffer.alloc(totalSize);
    let offset = 0;

    const headerFlags = (hasTotal ? 0b01 : 0) | (hasTotal && approxTotal ? 0b10 : 0);
    buf.writeUInt8(headerFlags, offset); offset += 1;
    buf.writeUInt8(searchBackendCode, offset); offset += 1;
    buf.writeDoubleLE(seq ?? 0, offset); offset += 8;
    buf.writeDoubleLE(hasTotal ? total : 0, offset); offset += 8;
    buf.writeUInt16LE(hashRows.length, offset); offset += 2;

    for (const row of hashRows) {
        const hasCreateDate = row.create_date !== null && row.create_date !== undefined;
        const flags = (row.isGroup ? 0b01 : 0) | (hasCreateDate ? 0b10 : 0);
        buf.writeUInt8(flags, offset); offset += 1;

        const idBytes = Buffer.byteLength(row.id, 'utf8');
        buf.writeUInt16LE(idBytes, offset); offset += 2;
        buf.write(row.id, offset, idBytes, 'utf8'); offset += idBytes;

        buf.writeUInt32LE(row.favHash >>> 0, offset); offset += 4;
        buf.writeUInt32LE(row.tagIdsHash >>> 0, offset); offset += 4;
        buf.writeUInt32LE(row.contentHash >>> 0, offset); offset += 4;

        buf.writeDoubleLE(row.date_added ?? 0, offset); offset += 8;
        buf.writeDoubleLE(hasCreateDate ? row.create_date : 0, offset); offset += 8;
        buf.writeDoubleLE(row.date_last_chat ?? 0, offset); offset += 8;
        buf.writeDoubleLE(row.chat_size ?? 0, offset); offset += 8;
        buf.writeDoubleLE(row.data_size ?? 0, offset); offset += 8;

        const chatBytes = row.chat ? Buffer.byteLength(row.chat, 'utf8') : 0;
        buf.writeUInt16LE(chatBytes, offset); offset += 2;
        if (chatBytes > 0) {
            buf.write(row.chat, offset, chatBytes, 'utf8'); offset += chatBytes;
        }
    }

    buf.writeUInt16LE(tokenBytes, offset); offset += 2;
    if (tokenBytes > 0) {
        buf.write(token, offset, tokenBytes, 'utf8'); offset += tokenBytes;
    }

    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Per-test fake server: character fixtures are their shallow records, group fixtures their stamped group
 * objects, `live` the per-id fields a hash row carries outside its hashes, and `queryResponses` the /query
 * answers in call order.
 */
let server;
let liveCounter;

/** @param {object} fields Stored as the shallow record shallow_json holds for a card with these fields. */
function addCharacter(fields) {
    const character = { fav: false, tag_ids: [], ...fields, data: shallowCharacterData(fields, false) };
    liveCounter++;
    server.characters.set(character.avatar, character);
    server.live.set(character.avatar, {
        chat: `${character.avatar} chat ${liveCounter}`,
        date_added: 1000 + liveCounter,
        create_date: 2000 + liveCounter,
        date_last_chat: 3000 + liveCounter,
        chat_size: 4000 + liveCounter,
        data_size: 5000 + liveCounter,
    });
    return character;
}

function addGroup(group) {
    liveCounter++;
    server.groups.set(group.id, group);
    // The server never ships a chat for a group hash row.
    server.live.set(group.id, {
        chat: null,
        date_added: 1000 + liveCounter,
        create_date: 2000 + liveCounter,
        date_last_chat: 3000 + liveCounter,
        chat_size: 4000 + liveCounter,
        data_size: 5000 + liveCounter,
    });
    return group;
}

/**
 * The next /query answer: `ids` in server order, each a character or group fixture id. With `unchanged`, the
 * answer is the server's JSON `{seq, token, unchanged: true}` stub instead.
 */
function queueQuery({ ids = [], total = undefined, approxTotal = false, seq, token = null, searchBackend = undefined, unchanged = false }) {
    server.queryResponses.push({ ids, total, approxTotal, seq, token, searchBackend, unchanged });
}

function jsonResponse(data) {
    return {
        ok: true,
        headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
        json: async () => data,
    };
}

function hashRowFor(id) {
    if (server.characters.has(id)) {
        const hashes = characterHashes(server.characters.get(id));
        return { id, isGroup: false, favHash: hashes.fav, tagIdsHash: hashes.tagIds, contentHash: hashes.content, ...server.live.get(id) };
    }
    const hashes = groupHashes(server.groups.get(id));
    return { id, isGroup: true, favHash: hashes.fav, tagIdsHash: hashes.tagIds, contentHash: hashes.content, ...server.live.get(id) };
}

async function fakeFetch(url, init) {
    const body = JSON.parse(init.body);
    if (url === '/api/characters/query') {
        const next = server.queryResponses.shift();
        if (!next) throw new Error('unexpected /api/characters/query call');
        if (next.unchanged) return jsonResponse({ seq: next.seq, token: next.token, unchanged: true });
        if (!body.want.includes('hashes')) {
            const payload = { seq: next.seq, token: next.token };
            if (next.total !== undefined) payload.total = next.approxTotal ? `~${next.total}` : next.total;
            if (next.searchBackend !== undefined) payload.searchBackend = next.searchBackend;
            return jsonResponse(payload);
        }
        const buffer = encodeQueryHashes({
            seq: next.seq, token: next.token, total: next.total, approxTotal: next.approxTotal, searchBackend: next.searchBackend,
            hashRows: next.ids.map(hashRowFor),
        });
        return {
            ok: true,
            headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/octet-stream' : null },
            arrayBuffer: async () => buffer,
        };
    }
    if (url === '/api/characters/batch') {
        if (!Array.isArray(body.fields)) throw new Error('/api/characters/batch full-record mode is not faked');
        const data = body.avatars
            .filter(avatar => server.characters.has(avatar))
            .map(avatar => {
                const shallow = server.characters.get(avatar);
                const filtered = { avatar };
                for (const field of body.fields) {
                    if (field in shallow) filtered[field] = shallow[field];
                }
                return filtered;
            });
        return { ok: true, json: async () => data };
    }
    if (url === '/api/groups/batch') {
        if (Array.isArray(body.fields)) throw new Error('/api/groups/batch field-filtered mode is not faked');
        const data = body.ids
            .filter(id => server.groups.has(id))
            .map(id => {
                const group = server.groups.get(id);
                return { ...group, id, fav: !!group.fav, tag_ids: group.tag_ids ?? [] };
            });
        return { ok: true, json: async () => data };
    }
    throw new Error(`unexpected fetch to ${url}`);
}

/** What hash mode returns for a character fixture. */
function hashModeCharacter(character) {
    return { ...character, ...server.live.get(character.avatar), shallow: true };
}

/** What hash mode returns for a group fixture (fixtures carry `fav`/`tag_ids`, as /api/groups/batch stamps them). */
function hashModeGroup(group) {
    return { ...group, ...server.live.get(group.id) };
}

async function cacheCharacters(...characters) {
    await saveCachedCharactersFake(characters.map(character => ({ avatar: character.avatar, character })));
}

function fetchedUrls() {
    return global.fetch.mock.calls.map(([url]) => url);
}

// None of these load in a plain node env: script.js assumes jQuery/DOM, character-store.js imports script.js,
// and character-cache.js pulls in lib.js, which needs `window`. `charactersStore` exists only so the module's
// default `characterRepository` singleton constructs on import; tests use their own store from makeStore().
jest.unstable_mockModule('../public/script.js', () => ({
    unshallowCharacter: unshallowCharacterMock,
}));
jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({
    getRequestHeaders: getRequestHeadersMock,
}));
jest.unstable_mockModule('../public/scripts/character-store.js', () => ({
    charactersStore: { get: () => undefined, has: () => false, onChange: () => () => {} },
}));
jest.unstable_mockModule('../public/scripts/character-cache.js', () => ({
    getCachedEntriesByIds: getCachedEntriesByIdsFake,
    saveCachedCharacters: saveCachedCharactersFake,
    getCachedGroupEntriesByIds: getCachedGroupEntriesByIdsFake,
    saveCachedGroups: saveCachedGroupsFake,
}));

/** @type {typeof import('../public/scripts/character-repository.js').CharacterRepository} */
let CharacterRepository;
/** @type {typeof import('../public/scripts/character-repository.js').buildCharacterQuery} */
let buildCharacterQuery;
/** @type {typeof import('../public/scripts/character-repository.js').isServerQueryableSort} */
let isServerQueryableSort;
/** @type {typeof import('../public/scripts/character-repository.js').normalizeQueryRow} */
let normalizeQueryRow;
/** @type {typeof import('../public/scripts/character-repository.js').CharacterQueryError} */
let CharacterQueryError;
/** @type {typeof import('../public/scripts/character-repository.js').isInvalidSortFieldError} */
let isInvalidSortFieldError;

// Re-imported per test: the module keeps a last-response-per-request cache that would otherwise carry `ifToken`
// from one test's request into another's.
beforeEach(async () => {
    jest.resetModules();
    ({ CharacterRepository, buildCharacterQuery, isServerQueryableSort, normalizeQueryRow, CharacterQueryError, isInvalidSortFieldError } = await import('../public/scripts/character-repository.js'));
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
    cacheRecords = new Map();
    server = { characters: new Map(), groups: new Map(), live: new Map(), queryResponses: [] };
    liveCounter = 0;
    global.fetch = jest.fn(fakeFetch);
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

    test('falls back to a hash-mode /query filter.ids call for a non-resident id, and does not write it into the store', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        const bob = addCharacter({ avatar: 'bob', name: 'Bob' });
        queueQuery({ ids: ['bob'], seq: 7 });

        const result = await repo.get('bob');

        expect(result).toEqual(hashModeCharacter(bob));
        expect(fetchedUrls()).toEqual(['/api/characters/query', '/api/characters/batch']);
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.filter).toEqual({ ids: ['bob'] });
        expect(body.want).toEqual(['hashes']);
        // The deliberate non-caching behavior (see get()'s doc comment): a server-fallback fetch must never
        // silently grow the resident store, since call sites elsewhere treat its size as "the boot-loaded
        // library" (design doc §4.1's "N hidden" badge).
        expect(store.get).not.toHaveBeenCalledWith('bob', expect.anything());
        expect(store.byId.has('bob')).toBe(false);
    });

    test('returns undefined for an id that resolves to no rows (a true miss, not merely non-resident)', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        queueQuery({ ids: [], total: 0, seq: 1 });

        await expect(repo.get('ghost')).resolves.toBeUndefined();
    });
});

describe('getMany()', () => {
    test('splits resident vs non-resident and only fetches the missing ones, in one batched call', async () => {
        const alice = { avatar: 'alice', name: 'Alice' };
        const store = makeStore([alice]);
        const repo = new CharacterRepository(store);
        const bob = addCharacter({ avatar: 'bob', name: 'Bob' });
        const carol = addCharacter({ avatar: 'carol', name: 'Carol' });
        await cacheCharacters(bob, carol);
        queueQuery({ ids: ['bob', 'carol'], total: 2, seq: 3 });

        const result = await repo.getMany(['alice', 'bob', 'carol']);

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.filter.ids).toEqual(['bob', 'carol']);
        expect(result.get('alice')).toBe(alice);
        expect(result.get('bob')).toEqual(hashModeCharacter(bob));
        expect(result.get('carol')).toEqual(hashModeCharacter(carol));
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
        queueQuery({ ids: [], total: 0, seq: 1 });

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
    test('posts the filter/sort/page/pageSize shape with want rows→hashes, and returns the decoded rows/total/seq', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        const a = addCharacter({ avatar: 'a', name: 'A' });
        queueQuery({ ids: ['a'], total: 1, seq: 5, searchBackend: 'tantivy' });

        const filter = { search: 'tsundere', fav: true };
        const sort = { field: 'random', seed: 42 };
        const result = await repo.query(filter, sort, 2, 50, ['rows', 'total']);

        expect(result).toEqual({ rows: [hashModeCharacter(a)], total: 1, seq: 5, token: null, searchBackend: 'tantivy' });
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('/api/characters/query');
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual(getRequestHeadersMock());
        expect(JSON.parse(init.body)).toEqual({
            filter, sort, page: 2, pageSize: 50, want: ['hashes', 'total'],
        });
    });

    test('passes an approximate (~-prefixed) total through unchanged, never coercing it to a number', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        queueQuery({ ids: [], total: 12345, approxTotal: true, seq: 9 });

        const result = await repo.query({}, { field: 'name', order: 'asc' }, 1, 100);

        expect(result.total).toBe('~12345');
        expect(typeof result.total).toBe('string');
    });

    test('defaults page/pageSize/want (with rows sent as hashes) when not supplied', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        queueQuery({ ids: [], total: 0, seq: 0 });

        await repo.query({ fav: true });

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.page).toBe(1);
        expect(body.pageSize).toBe(100);
        expect(body.want).toEqual(['hashes', 'total']);
    });

    test('a cache miss costs one /batch fetch for just the missing ids; a cache hit costs none', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        const alice = addCharacter({ avatar: 'alice', name: 'Alice' });
        const bob = addCharacter({ avatar: 'bob', name: 'Bob' });
        const carol = addCharacter({ avatar: 'carol', name: 'Carol' });
        await cacheCharacters(alice);
        queueQuery({ ids: ['alice', 'bob', 'carol'], total: 3, seq: 1 });

        const first = await repo.query({}, { field: 'name', order: 'asc' });

        expect(first.rows).toEqual([alice, bob, carol].map(hashModeCharacter));
        expect(fetchedUrls()).toEqual(['/api/characters/query', '/api/characters/batch']);
        expect(JSON.parse(global.fetch.mock.calls[1][1].body).avatars).toEqual(['bob', 'carol']);

        global.fetch.mockClear();
        queueQuery({ ids: ['carol', 'bob', 'alice'], total: 3, seq: 1 });

        const second = await repo.query({}, { field: 'name', order: 'desc' });

        expect(second.rows).toEqual([carol, bob, alice].map(hashModeCharacter));
        expect(fetchedUrls()).toEqual(['/api/characters/query']);
    });

    test('hash mode sends the last response\'s token as ifToken, never ifSeq, and reuses that response when the server answers unchanged', async () => {
        const repo = new CharacterRepository(makeStore([]));
        const alice = addCharacter({ avatar: 'alice', name: 'Alice' });
        const sort = { field: 'name', order: 'asc' };
        queueQuery({ ids: ['alice'], total: 1, seq: 4, token: 'tokenA' });

        const first = await repo.query({ search: 'ali' }, sort);
        expect(first).toEqual({ rows: [hashModeCharacter(alice)], total: 1, seq: 4, token: 'tokenA' });
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).not.toHaveProperty('ifToken');

        global.fetch.mockClear();
        queueQuery({ seq: 4, token: 'tokenA', unchanged: true });

        const second = await repo.query({ search: 'ali' }, sort);
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.ifToken).toBe('tokenA');
        expect(body).not.toHaveProperty('ifSeq');
        expect(second).toBe(first);
    });

    test('hash mode keeps a response under its new token even when seq did not move', async () => {
        const repo = new CharacterRepository(makeStore([]));
        const alice = addCharacter({ avatar: 'alice', name: 'Alice' });
        const bob = addCharacter({ avatar: 'bob', name: 'Bob' });
        await cacheCharacters(alice, bob);
        queueQuery({ ids: ['alice'], total: 1, seq: 4, token: 'tokenA' });
        await repo.query({ search: 'a' });

        // The index caught up with a write: same seq, new token, a new hit.
        queueQuery({ ids: ['alice', 'bob'], total: 2, seq: 4, token: 'tokenB' });
        const second = await repo.query({ search: 'a' });
        expect(second.rows).toEqual([alice, bob].map(hashModeCharacter));
        expect(second.token).toBe('tokenB');

        global.fetch.mockClear();
        queueQuery({ seq: 4, token: 'tokenB', unchanged: true });
        const third = await repo.query({ search: 'a' });
        expect(JSON.parse(global.fetch.mock.calls[0][1].body).ifToken).toBe('tokenB');
        expect(third).toBe(second);
    });

    test('a response with a null token is not kept, so the next identical request sends no ifToken', async () => {
        const repo = new CharacterRepository(makeStore([]));
        queueQuery({ ids: [], total: 0, seq: 4, token: null });
        await repo.query({ includeGroups: true });

        global.fetch.mockClear();
        queueQuery({ ids: [], total: 0, seq: 4, token: null });
        await repo.query({ includeGroups: true });
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body).not.toHaveProperty('ifToken');
        expect(body).not.toHaveProperty('ifSeq');
    });

    test('the JSON transport sends the last response\'s token as ifToken, never ifSeq, and reuses that response when unchanged', async () => {
        const repo = new CharacterRepository(makeStore([]));
        queueQuery({ total: 3, seq: 4, token: 'tokenA' });

        const first = await repo.query({ search: 'a' }, undefined, 1, 100, ['total']);
        expect(first).toEqual({ total: 3, seq: 4, token: 'tokenA' });

        global.fetch.mockClear();
        queueQuery({ seq: 4, token: 'tokenA', unchanged: true });

        const second = await repo.query({ search: 'a' }, undefined, 1, 100, ['total']);
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.ifToken).toBe('tokenA');
        expect(body).not.toHaveProperty('ifSeq');
        expect(second).toBe(first);
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
        const characters = [addCharacter({ avatar: 'a', name: 'A' }), addCharacter({ avatar: 'b', name: 'B' })];
        await cacheCharacters(...characters);
        queueQuery({ ids: ['a', 'b'], seq: 1 });

        const result = await repo.queryAll({ fav: true }, { field: 'name' });

        expect(result).toEqual(characters.map(hashModeCharacter));
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
        const fullPage = Array.from({ length: 2000 }, (_, i) => addCharacter({ avatar: `c${i}` }));
        const shortPage = [addCharacter({ avatar: 'last' })];
        await cacheCharacters(...fullPage, ...shortPage);
        queueQuery({ ids: fullPage.map(c => c.avatar), total: 2001, approxTotal: true, seq: 1 });
        queueQuery({ ids: shortPage.map(c => c.avatar), seq: 1 });

        const result = await repo.queryAll();

        expect(result).toEqual([...fullPage, ...shortPage].map(hashModeCharacter));
        expect(global.fetch).toHaveBeenCalledTimes(2);
        const secondCallBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        expect(secondCallBody.page).toBe(2);
    });

    test('an empty result set makes exactly one call and returns an empty array', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        queueQuery({ ids: [], total: 0, seq: 1 });

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
    test('query() forwards filter.includeGroups verbatim in a hash-mode request and returns tagged character/group rows', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        const alice = addCharacter({ avatar: 'alice', name: 'Alice' });
        const party = addGroup({ id: 'group-1', name: 'The Party', members: ['alice'], fav: false, tag_ids: [] });
        queueQuery({ ids: ['alice', 'group-1'], total: 2, seq: 1 });

        const result = await repo.query({ includeGroups: true }, { field: 'name', order: 'asc' }, 1, 50);

        expect(result).toEqual({
            rows: [
                { type: 'character', item: hashModeCharacter(alice) },
                { type: 'group', item: hashModeGroup(party) },
            ],
            total: 2,
            seq: 1,
            token: null,
        });
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
            filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 50, want: ['hashes', 'total'],
        });
        const groupBatchCalls = global.fetch.mock.calls.filter(([url]) => url === '/api/groups/batch');
        expect(groupBatchCalls.map(([, init]) => JSON.parse(init.body))).toEqual([{ ids: ['group-1'] }]);
    });

    test('queryAll() loops the tagged-row shape the same way it loops bare Character[] pages', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        const a = addCharacter({ avatar: 'a', name: 'A' });
        const g1 = addGroup({ id: 'g1', name: 'G1', members: ['a'], fav: false, tag_ids: [] });
        queueQuery({ ids: ['a', 'g1'], seq: 1 });

        const result = await repo.queryAll({ includeGroups: true }, { field: 'name' });

        expect(result).toEqual([
            { type: 'character', item: hashModeCharacter(a) },
            { type: 'group', item: hashModeGroup(g1) },
        ]);
    });
});

describe('isServerQueryableSort()', () => {
    // The client no longer keeps its own copy of "which columns the server supports" (that used to be
    // QUERYABLE_CLIENT_SORT_FIELDS, removed - see this function's doc comment for the drift it caused twice).
    // It answers "should the caller even attempt /query for this field", which is true for essentially
    // everything - real column names, made-up ones, 'random' - the server's own 400 invalid-sort-field response
    // is what actually decides support now (see isInvalidSortFieldError() below).
    test('accepts every column /query can actually sort by (src/character-metadata-db.js QUERYABLE_SORT_COLUMNS)', () => {
        for (const field of ['name', 'date_last_chat', 'chat_size', 'fav', 'create_date', 'data_size']) {
            expect(isServerQueryableSort(field)).toBe(true);
        }
    });

    test('accepts "random" unconditionally (a seed is checked separately by the caller)', () => {
        expect(isServerQueryableSort('random')).toBe(true);
    });

    test('accepts an unknown/made-up field name - no client-side allowlist to reject it against anymore, the server\'s own rejection is the authority', () => {
        expect(isServerQueryableSort('made_up_field')).toBe(true);
    });

    test('accepts undefined - buildCharacterQuery() maps that to no sort at all, which never risks an invalid-sort-field rejection', () => {
        expect(isServerQueryableSort(undefined)).toBe(true);
    });

    test('rejects "search" - relevance order needs an id list from the search index, a completely different code path than a /query sort.field column', () => {
        expect(isServerQueryableSort('search')).toBe(false);
    });
});

describe('CharacterQueryError / isInvalidSortFieldError()', () => {
    test('query() rejects with a CharacterQueryError carrying status/reason/body on a non-ok response', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        global.fetch.mockResolvedValue({
            ok: false,
            status: 400,
            json: async () => ({ error: true, reason: 'invalid-sort-field' }),
        });

        let caught;
        try {
            await repo.query({}, { field: 'bogus' });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(CharacterQueryError);
        expect(caught.status).toBe(400);
        expect(caught.reason).toBe('invalid-sort-field');
        expect(caught.body).toEqual({ error: true, reason: 'invalid-sort-field' });
    });

    test('isInvalidSortFieldError() is true only for a caught invalid-sort-field rejection', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        global.fetch.mockResolvedValue({
            ok: false,
            status: 400,
            json: async () => ({ error: true, reason: 'invalid-sort-field' }),
        });

        try {
            await repo.query({}, { field: 'bogus' });
        } catch (error) {
            expect(isInvalidSortFieldError(error)).toBe(true);
        }
        expect.assertions(1);
    });

    test('isInvalidSortFieldError() is false for a different reason (e.g. a 500, or a reason that is not invalid-sort-field)', async () => {
        expect(isInvalidSortFieldError(new Error('network down'))).toBe(false);
        expect(isInvalidSortFieldError(new CharacterQueryError('boom', { status: 500 }))).toBe(false);
        expect(isInvalidSortFieldError(new CharacterQueryError('boom', { status: 400, reason: 'search-sort-requires-search' }))).toBe(false);
    });

    test('isInvalidSortFieldError() is false for a genuine 500/server error response', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        global.fetch.mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => ({ error: true, reason: 'internal-error' }),
        });

        try {
            await repo.query({}, { field: 'name' });
        } catch (error) {
            expect(isInvalidSortFieldError(error)).toBe(false);
        }
        expect.assertions(1);
    });

    test('isInvalidSortFieldError() is false for a network-level failure (fetch itself rejects)', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        global.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

        try {
            await repo.query({}, { field: 'name' });
        } catch (error) {
            expect(error).not.toBeInstanceOf(CharacterQueryError);
            expect(isInvalidSortFieldError(error)).toBe(false);
        }
        expect.assertions(2);
    });
});
