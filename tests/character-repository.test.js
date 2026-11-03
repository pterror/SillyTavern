import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import {
    groupDigestFavHash, groupDigestTagIdsHash, groupDigestContentHash, shallowCharacterData,
} from '../public/scripts/hash-utils.js';
import { installBrowserStorage } from './util/browser-storage.js';

const getRequestHeadersMock = jest.fn(() => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }));
const unshallowCharacterMock = jest.fn();

function groupHashes(group) {
    return {
        fav: groupDigestFavHash(group),
        tagIds: groupDigestTagIdsHash(group),
        content: groupDigestContentHash(group),
    };
}

/** @type {Map<string, Map<string, any>>} */
const localforageStores = new Map();

function createFakeLocalforageInstance({ name }) {
    let records = localforageStores.get(name);
    if (!records) {
        records = new Map();
        localforageStores.set(name, records);
    }
    return {
        getItem: async key => (records.has(key) ? structuredClone(records.get(key)) : null),
        setItem: async (key, value) => { records.set(key, structuredClone(value)); return value; },
        removeItem: async key => { records.delete(key); },
        iterate: async (fn) => {
            for (const [key, value] of [...records]) {
                const result = fn(structuredClone(value), key);
                if (result !== undefined) return result;
            }
        },
    };
}

installBrowserStorage({ quota: 1e9 });

const SEARCH_BACKEND_CODES = { tantivy: 1, native: 2, wasm: 3, unavailable: 4 };

/**
 * @param {{seq:number, token:string|null, total:number|undefined, approxTotal:boolean, hashRows:object[], searchBackend?:string}} params
 * @returns {ArrayBuffer}
 */
function encodeQueryHashes({ seq, token, total, approxTotal, hashRows, searchBackend, more = false, cursor }) {
    const hasTotal = typeof total === 'number';
    const cursorBytes = cursor ? Buffer.byteLength(cursor, 'utf8') : 0;
    const searchBackendCode = SEARCH_BACKEND_CODES[searchBackend] ?? 0;

    let totalSize = 1 + 1 + 8 + 8 + 2;
    for (const row of hashRows) {
        const idBytes = Buffer.byteLength(row.id, 'utf8');
        const chatBytes = row.chat ? Buffer.byteLength(row.chat, 'utf8') : 0;
        totalSize += 1 + 2 + idBytes + (row.isGroup ? 4 + 4 + 4 : 8 + 4) + 8 + 8 + 8 + 8 + 8 + 2 + chatBytes;
    }
    const tokenBytes = token ? Buffer.byteLength(token, 'utf8') : 0;
    totalSize += 2 + tokenBytes;
    if (cursor) totalSize += 2 + cursorBytes;

    const buf = Buffer.alloc(totalSize);
    let offset = 0;

    const headerFlags = (hasTotal ? 0b01 : 0) | (hasTotal && approxTotal ? 0b10 : 0) | (more ? 0b100 : 0) | (cursor ? 0b1000 : 0);
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

        if (row.isGroup) {
            buf.writeUInt32LE(row.favHash >>> 0, offset); offset += 4;
            buf.writeUInt32LE(row.tagIdsHash >>> 0, offset); offset += 4;
            buf.writeUInt32LE(row.contentHash >>> 0, offset); offset += 4;
        } else {
            buf.writeDoubleLE(row.version, offset); offset += 8;
            buf.writeUInt32LE((row.tagIdsHash ?? 0) >>> 0, offset); offset += 4;
        }

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
    if (cursor) {
        buf.writeUInt16LE(cursorBytes, offset); offset += 2;
        buf.write(cursor, offset, cursorBytes, 'utf8'); offset += cursorBytes;
    }

    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

let server;
let liveCounter;
let versionCounter;

/** @param {object} fields */
function addCharacter(fields) {
    const character = { fav: false, tag_ids: [], ...fields, data: shallowCharacterData(fields, false) };
    liveCounter++;
    server.characters.set(character.avatar, character);
    server.versions.set(character.avatar, ++versionCounter);
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

function queueQuery({ ids = [], total = undefined, approxTotal = false, seq, token = null, searchBackend = undefined, unchanged = false, more = false, cursor = undefined, refused = undefined }) {
    server.queryResponses.push({ ids, total, approxTotal, seq, token, searchBackend, unchanged, more, cursor, refused });
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
        return { id, isGroup: false, version: server.versions.get(id), ...server.live.get(id) };
    }
    const hashes = groupHashes(server.groups.get(id));
    return { id, isGroup: true, favHash: hashes.fav, tagIdsHash: hashes.tagIds, contentHash: hashes.content, ...server.live.get(id) };
}

async function fakeFetch(url, init) {
    const body = JSON.parse(init.body);
    if (url === '/api/characters/query') {
        const next = server.queryResponses.shift();
        if (!next) throw new Error('unexpected /api/characters/query call');
        if (next.refused) return { ok: false, status: 400, json: async () => ({ error: true, reason: next.refused }) };
        if (next.unchanged) return jsonResponse({ seq: next.seq, token: next.token, unchanged: true });
        if (!body.want.includes('hashes')) {
            const payload = { seq: next.seq, token: next.token };
            if (next.total !== undefined) payload.total = next.approxTotal ? `~${next.total}` : next.total;
            if (next.searchBackend !== undefined) payload.searchBackend = next.searchBackend;
            if (next.cursor !== undefined) payload.cursor = next.cursor;
            return jsonResponse(payload);
        }
        const buffer = encodeQueryHashes({
            seq: next.seq, token: next.token, total: next.total, approxTotal: next.approxTotal, searchBackend: next.searchBackend,
            hashRows: next.ids.map(hashRowFor), more: next.more, cursor: next.cursor,
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

function hashModeCharacter(character) {
    return { ...character, ...server.live.get(character.avatar), shallow: true };
}

function hashModeGroup(group) {
    return { ...group, ...server.live.get(group.id) };
}

async function cacheCharacters(...characters) {
    const { keepRows, characterRowKey } = await import('../public/scripts/character-cache.js');
    await keepRows(characters.map(character => ({ key: characterRowKey({ id: character.avatar, version: server.versions.get(character.avatar), tagIdsHash: 0 }), row: character })));
}

function fetchedUrls() {
    return global.fetch.mock.calls.map(([url]) => url);
}

jest.unstable_mockModule('../public/script.js', () => ({
    unshallowCharacter: unshallowCharacterMock,
}));
jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({
    getRequestHeaders: getRequestHeadersMock,
}));
jest.unstable_mockModule('../public/scripts/character-store.js', () => ({
    charactersStore: { get: () => undefined, has: () => false, onChange: () => () => {} },
}));
jest.unstable_mockModule('../public/lib.js', () => ({ localforage: { createInstance: createFakeLocalforageInstance } }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'tester' }));
/** @type {Map<string, any>} */
const stored = new Map();
let keepPages = false;
jest.unstable_mockModule('../public/scripts/query-result-cache.js', () => ({
    setQueryCacheUser: () => {},
    readQueryCache: async key => (keepPages && stored.get(key)?.hashRows ? structuredClone(stored.get(key)) : null),
    writeQueryCache: async (key, entry) => { stored.set(key, structuredClone(entry)); },
    readQueryCursor: async key => stored.get(key)?.cursor ?? null,
    writeQueryCursor: async (key, cursor) => {
        const entry = stored.get(key);
        if (entry?.hashRows) {
            if (cursor === undefined) delete entry.cursor;
            else entry.cursor = cursor;
        } else if (cursor === undefined) {
            stored.delete(key);
        } else {
            stored.set(key, { cursor });
        }
    },
    pinQueryCache: async () => {},
    pinnedQueryCacheKeys: async () => [],
}));
beforeEach(() => {
    stored.clear();
    keepPages = false;
});

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

beforeEach(async () => {
    jest.resetModules();
    ({ CharacterRepository, buildCharacterQuery, isServerQueryableSort, normalizeQueryRow, CharacterQueryError, isInvalidSortFieldError } = await import('../public/scripts/character-repository.js'));
});

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
    for (const records of localforageStores.values()) records.clear();
    server = { characters: new Map(), versions: new Map(), groups: new Map(), live: new Map(), queryResponses: [] };
    liveCounter = 0;
    versionCounter = 0;
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

    test('more missing ids than one server page holds are asked for in page-sized chunks, none dropped', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        const characters = Array.from({ length: 2001 }, (_, i) => addCharacter({ avatar: `c${String(i).padStart(4, '0')}`, name: `C${i}` }));
        await cacheCharacters(...characters);
        const ids = characters.map(c => c.avatar);
        queueQuery({ ids: ids.slice(0, 2000), total: 2000, seq: 1 });
        queueQuery({ ids: ids.slice(2000), total: 1, seq: 1 });

        const result = await repo.getMany(ids);

        const queryBodies = global.fetch.mock.calls
            .filter(([url]) => url === '/api/characters/query')
            .map(([, init]) => JSON.parse(init.body));
        expect(queryBodies.map(body => body.filter.ids.length)).toEqual([2000, 1]);
        expect(result.size).toBe(2001);
        expect(result.has('c2000')).toBe(true);
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
            if (id === 'alice') Object.assign(alice, { shallow: false, description: 'hydrated' });
        });

        const result = await repo.full('alice');

        expect(unshallowCharacterMock).toHaveBeenCalledWith('alice');
        expect(result).toBe(alice);
        expect(result.description).toBe('hydrated');
    });

    test('reads a non-resident id from the server without making it resident', async () => {
        const store = makeStore([]);
        const repo = new CharacterRepository(store);
        global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ avatar: 'bob', name: 'Bob', description: 'full', chat: null }) });

        const result = await repo.full('bob');

        expect(result).toEqual({ avatar: 'bob', name: 'Bob', description: 'full', chat: '', shallow: false });
        expect(store.has('bob')).toBe(false);
        expect(unshallowCharacterMock).not.toHaveBeenCalled();
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('/api/characters/get');
        expect(JSON.parse(init.body)).toEqual({ avatar_url: 'bob' });
    });

    test('a non-resident id the server does not know is not-found, not an error', async () => {
        const repo = new CharacterRepository(makeStore([]));
        global.fetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });

        await expect(repo.full('ghost')).resolves.toBeUndefined();
    });

    test('any other failed read rejects', async () => {
        const repo = new CharacterRepository(makeStore([]));
        global.fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

        await expect(repo.full('bob')).rejects.toThrow(/500/);
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

    test('a page the server stopped short at its work cap is filled by following its cursor, one request at a time', async () => {
        const repo = new CharacterRepository(makeStore([]));
        const [a, b, c] = ['a', 'b', 'c'].map(avatar => addCharacter({ avatar, name: avatar.toUpperCase() }));
        queueQuery({ ids: ['a'], total: 40, approxTotal: true, seq: 1, more: true, cursor: 'k1' });
        queueQuery({ ids: [], seq: 1, more: true, cursor: 'k2' });
        queueQuery({ ids: ['b', 'c'], total: 3, seq: 2, cursor: 'k3' });

        const result = await repo.query({ search: 'x', tags: { include: ['t'] } }, { field: 'name', order: 'asc' }, 1, 3, ['rows', 'total']);

        expect(result.rows).toEqual([a, b, c].map(hashModeCharacter));
        expect(result.total).toBe(3);
        expect(result.cursor).toBe('k3');
        expect(result).not.toHaveProperty('more');
        const bodies = global.fetch.mock.calls.filter(([url]) => url === '/api/characters/query').map(([, init]) => JSON.parse(init.body));
        expect(bodies.map(body => [body.cursor, body.pageSize])).toEqual([[undefined, 3], ['k1', 2], ['k2', 2]]);
    });

    test('the next page carries on from the cursor the last page ended at', async () => {
        const repo = new CharacterRepository(makeStore([]));
        addCharacter({ avatar: 'a', name: 'A' });
        addCharacter({ avatar: 'b', name: 'B' });
        queueQuery({ ids: ['a'], seq: 1, cursor: 'end-of-1' });
        queueQuery({ ids: ['b'], seq: 1 });

        await repo.query({ search: 'x' }, { field: 'name', order: 'asc' }, 1, 1, ['rows']);
        await repo.query({ search: 'x' }, { field: 'name', order: 'asc' }, 2, 1, ['rows']);

        const bodies = global.fetch.mock.calls.filter(([url]) => url === '/api/characters/query').map(([, init]) => JSON.parse(init.body));
        expect(bodies.map(body => [body.page, body.cursor])).toEqual([[1, undefined], [2, 'end-of-1']]);
    });

    test('a cursor the server refuses: the page is asked for again by its position', async () => {
        const repo = new CharacterRepository(makeStore([]));
        addCharacter({ avatar: 'a', name: 'A' });
        addCharacter({ avatar: 'b', name: 'B' });
        queueQuery({ ids: ['a'], seq: 1, cursor: 'end-of-1' });
        queueQuery({ refused: 'invalid-cursor' });
        queueQuery({ ids: ['b'], seq: 1 });

        await repo.query({ search: 'x' }, { field: 'name', order: 'asc' }, 1, 1, ['rows']);
        const second = await repo.query({ search: 'x' }, { field: 'name', order: 'asc' }, 2, 1, ['rows']);

        expect(second.rows.map(row => row.avatar)).toEqual(['b']);
        const bodies = global.fetch.mock.calls.filter(([url]) => url === '/api/characters/query').map(([, init]) => JSON.parse(init.body));
        expect(bodies.map(body => [body.page, body.cursor])).toEqual([[1, undefined], [2, 'end-of-1'], [2, undefined]]);
        expect([...stored.values()].map(entry => entry.cursor)).not.toContain('end-of-1');
    });

    const sent = () => global.fetch.mock.calls.filter(([url]) => url === '/api/characters/query').map(([, init]) => JSON.parse(init.body)).map(body => [body.page, body.cursor]);
    const nameSort = { field: 'name', order: 'asc' };

    test('a page starts from the cursor browser storage kept for the page before: next and previous alike', async () => {
        const repo = new CharacterRepository(makeStore([]));
        for (const avatar of ['a', 'b', 'c']) addCharacter({ avatar, name: avatar.toUpperCase() });
        queueQuery({ ids: ['a'], seq: 1, token: 't1', cursor: 'end-1' });
        queueQuery({ ids: ['b'], seq: 1, token: 't2', cursor: 'end-2' });
        queueQuery({ ids: ['c'], seq: 1, token: 't3' });
        queueQuery({ ids: ['b'], seq: 1, token: 't2', cursor: 'end-2' });

        for (const page of [1, 2, 3]) await repo.query({ search: 'x' }, nameSort, page, 1, ['rows']);
        const back = await repo.query({ search: 'x' }, nameSort, 2, 1, ['rows'], { onFresh: () => {} });

        expect(back.rows.map(row => row.avatar)).toEqual(['b']);
        expect(sent()).toEqual([[1, undefined], [2, 'end-1'], [3, 'end-2'], [2, 'end-1']]);
    });

    test('after a reload, a page starts from the cursor kept in browser storage, not from page memory', async () => {
        for (const avatar of ['a', 'b']) addCharacter({ avatar, name: avatar.toUpperCase() });
        queueQuery({ ids: ['a'], seq: 1, token: 't1', cursor: 'end-1' });
        queueQuery({ ids: ['b'], seq: 1, token: 't2' });

        await new CharacterRepository(makeStore([])).query({ search: 'x' }, nameSort, 1, 1, ['rows']);
        const beforeReload = sent();
        jest.resetModules();
        const { CharacterRepository: Reloaded } = await import('../public/scripts/character-repository.js');
        const second = await new Reloaded(makeStore([])).query({ search: 'x' }, nameSort, 2, 1, ['rows']);

        expect(second.rows.map(row => row.avatar)).toEqual(['b']);
        expect([...beforeReload, ...sent()]).toEqual([[1, undefined], [2, 'end-1']]);
    });

    test('a kept page refreshed after a reload is asked for from the cursor the page before ended at', async () => {
        keepPages = true;
        for (const avatar of ['a', 'b', 'c']) addCharacter({ avatar, name: avatar.toUpperCase() });
        queueQuery({ ids: ['a'], seq: 1, token: 't1', cursor: 'end-1' });
        queueQuery({ ids: ['b'], seq: 1, token: 't2', cursor: 'end-2' });
        queueQuery({ ids: ['c'], seq: 2, token: 't2b', cursor: 'end-2' });

        const repo = new CharacterRepository(makeStore([]));
        await repo.query({ search: 'x' }, nameSort, 1, 1, ['rows']);
        await repo.query({ search: 'x' }, nameSort, 2, 1, ['rows']);
        const beforeReload = sent();
        jest.resetModules();
        const { CharacterRepository: Reloaded } = await import('../public/scripts/character-repository.js');
        /** @type {(result: any) => void} */
        let onFresh = () => {};
        const fresh = new Promise(resolve => { onFresh = resolve; });
        const stale = await new Reloaded(makeStore([])).query({ search: 'x' }, nameSort, 2, 1, ['rows'], { onFresh });

        expect(stale.rows.map(row => row.avatar)).toEqual(['b']);
        expect((/** @type {any} */ (await fresh)).rows.map(row => row.avatar)).toEqual(['c']);
        expect([...beforeReload, ...sent()]).toEqual([[1, undefined], [2, 'end-1'], [2, 'end-1']]);
    });

    test('page 1, and a page whose page before browser storage didn\'t keep, are asked for by position', async () => {
        const repo = new CharacterRepository(makeStore([]));
        for (const avatar of ['a', 'b']) addCharacter({ avatar, name: avatar.toUpperCase() });
        queueQuery({ ids: ['b'], seq: 1, token: 't3', cursor: 'end-3' });
        queueQuery({ ids: ['a'], seq: 1, token: 't1', cursor: 'end-1' });

        await repo.query({ search: 'x' }, nameSort, 3, 1, ['rows']);
        await repo.query({ search: 'x' }, nameSort, 1, 1, ['rows']);

        expect(sent()).toEqual([[3, undefined], [1, undefined]]);
    });

    test('an answer without hash rows keeps its cursor alone, and the next page starts from it', async () => {
        const repo = new CharacterRepository(makeStore([]));
        queueQuery({ seq: 1, total: 5, cursor: 'j1' });
        queueQuery({ seq: 1, total: 5 });

        await repo.query({ search: 'x' }, nameSort, 1, 1, ['total']);
        await repo.query({ search: 'x' }, nameSort, 2, 1, ['total']);

        expect(sent()).toEqual([[1, undefined], [2, 'j1']]);
        expect([...stored.values()]).toEqual([{ cursor: 'j1' }]);
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

    test('hash mode sends the kept page\'s token as ifToken, never ifSeq, and rebuilds the unchanged page from kept rows without a download', async () => {
        keepPages = true;
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
        expect(second).not.toBe(first);
        expect(second).toEqual(first);
        expect(fetchedUrls()).toEqual(['/api/characters/query']);
    });

    test('hash mode keeps a page under its new token even when seq did not move', async () => {
        keepPages = true;
        const repo = new CharacterRepository(makeStore([]));
        const alice = addCharacter({ avatar: 'alice', name: 'Alice' });
        const bob = addCharacter({ avatar: 'bob', name: 'Bob' });
        await cacheCharacters(alice, bob);
        queueQuery({ ids: ['alice'], total: 1, seq: 4, token: 'tokenA' });
        await repo.query({ search: 'a' });

        queueQuery({ ids: ['alice', 'bob'], total: 2, seq: 4, token: 'tokenB' });
        const second = await repo.query({ search: 'a' });
        expect(second.rows).toEqual([alice, bob].map(hashModeCharacter));
        expect(second.token).toBe('tokenB');

        global.fetch.mockClear();
        queueQuery({ seq: 4, token: 'tokenB', unchanged: true });
        const third = await repo.query({ search: 'a' });
        expect(JSON.parse(global.fetch.mock.calls[0][1].body).ifToken).toBe('tokenB');
        expect(third).toEqual(second);
        expect(fetchedUrls()).toEqual(['/api/characters/query']);
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

describe('query() with includeGroups', () => {
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
});

describe('isServerQueryableSort()', () => {
    test('accepts every column /query can actually sort by', () => {
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
