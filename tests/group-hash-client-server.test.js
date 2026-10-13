import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';
import { groupContentFingerprint } from '../public/scripts/hash-utils.js';

// The real client path (character-repository.js -> character-cache.js) against the real server routes. Only the
// modules that can't load in node are replaced: IndexedDB (localforage) by an in-memory store that structured-
// clones like IndexedDB does, and the DOM-bound script.js/character-store.js/request-headers.js/user.js.

const USER_HANDLE = 'group-hash-test-user';

/** @type {Map<string, Map<string, any>>} localforage instance name -> key -> record */
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
        clear: async () => { records.clear(); },
        keys: async () => [...records.keys()],
        iterate: async (fn) => {
            for (const [key, value] of records) {
                const result = fn(structuredClone(value), key);
                if (result !== undefined) return result;
            }
        },
    };
}

jest.unstable_mockModule('../public/lib.js', () => ({
    localforage: { createInstance: createFakeLocalforageInstance },
}));
jest.unstable_mockModule('../public/scripts/user.js', () => ({
    getCurrentUserHandle: () => USER_HANDLE,
}));
jest.unstable_mockModule('../public/script.js', () => ({
    unshallowCharacter: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));
jest.unstable_mockModule('../public/scripts/character-store.js', () => ({
    charactersStore: { get: () => undefined, has: () => false, onChange: () => () => {} },
}));

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/user-stores.js')} */
let stores;
/** @type {typeof import('../src/endpoints/groups.js')} */
let groupsModule;
let TYPE;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {typeof fetch} */
const realFetch = globalThis.fetch;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    fixture = await import('./converted-user.fixture.js');
    // The routes' own module instance: clientResolve() resets modules between tests.
    stores = await import('../src/user-stores.js');
    ({ TYPE } = await import('../src/library-codes.js'));
    groupsModule = await import('../src/endpoints/groups.js');
    const { router: charactersRouter } = await import('../src/endpoints/characters.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/groups', groupsModule.router);
    app.use('/api/characters', charactersRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-group-hash-client-server-test-', stores);
    globalThis.DATA_ROOT = user.dataRoot;
    localforageStores.clear();
    // The client issues root-relative URLs; route them to the test server.
    globalThis.fetch = jest.fn((url, init) => realFetch(`${baseUrl}${url}`, init));
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    await user.close();
});

async function postJson(urlPath, body) {
    const response = await realFetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
}

/** @param {string} id @returns {Promise<Record<string, any>>} The group as stored. */
async function readGroupFile(id) {
    return /** @type {any} */ ((await user.store.lib.groups([id]))[0]);
}

/** Assigns a tag (made if there is none) to a group. */
async function assignGroupTag(id, tagId) {
    await user.store.lib.writeTag({ id: tagId, name: tagId });
    return (await user.store.lib.assignTag(TYPE.group, id, tagId, true));
}

/**
 * The hashes hash-mode /query ships for each group (layout: serializeQueryHashesBinary() in
 * src/endpoints/characters.js) - the server's digests as the client compares against them.
 * @returns {Promise<Map<string, {fav: number, tagIds: number, content: number}>>}
 */
async function serverGroupHashes() {
    const response = await realFetch(`${baseUrl}/api/characters/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 50, want: ['hashes'] }),
    });
    expect(response.status).toBe(200);
    const buffer = await response.arrayBuffer();
    const view = new DataView(buffer);
    const decoder = new TextDecoder();
    let offset = 1 + 1 + 8 + 8;
    const rowCount = view.getUint16(offset, true); offset += 2;
    const result = new Map();
    for (let i = 0; i < rowCount; i++) {
        const flags = view.getUint8(offset); offset += 1;
        const idLen = view.getUint16(offset, true); offset += 2;
        const id = decoder.decode(new Uint8Array(buffer, offset, idLen)); offset += idLen;
        const fav = view.getUint32(offset, true); offset += 4;
        const tagIds = view.getUint32(offset, true); offset += 4;
        const content = view.getUint32(offset, true); offset += 4;
        offset += 8 * 5;
        const chatLen = view.getUint16(offset, true); offset += 2 + chatLen;
        if (flags & 0b1) result.set(id, { fav, tagIds, content });
    }
    return result;
}

/** @param {string} id @returns {{group: object, hashes: {fav: number, tagIds: number, content: number, v: number}} | undefined} */
function cachedGroupRecord(id) {
    return localforageStores.get(`SillyTavern_GroupCache_${USER_HANDLE}`)?.get(id);
}

/**
 * One hash-mode page through a freshly imported client (so its per-request response cache starts empty and every
 * call resolves its hash rows against the group cache).
 * @returns {Promise<{groups: Map<string, object>, urls: string[]}>}
 */
async function clientResolve() {
    jest.resetModules();
    const { CharacterRepository } = await import('../public/scripts/character-repository.js');
    const store = { get: () => undefined, has: () => false, onChange: () => () => {} };
    const repo = new CharacterRepository(/** @type {any} */ (store));
    /** @type {jest.Mock} */ (globalThis.fetch).mockClear();
    const result = await repo.query({ includeGroups: true }, { field: 'name', order: 'asc' }, 1, 50, ['rows']);
    const urls = /** @type {jest.Mock} */ (globalThis.fetch).mock.calls.map(([url]) => url);
    const groups = new Map(result.rows.filter(r => r.type === 'group').map(r => [r.item.id, r.item]));
    return { groups, urls };
}

async function createGroup(body) {
    return postJson('/api/groups/create', { name: 'Group', members: ['a.png', 'b.png'], ...body });
}

describe('an unchanged group is a cache hit: the client caches the hashes the server ships', () => {
    test.each([
        ['tagged favourite', { fav: true }, ['tag-b', 'tag-a']],
        ['untagged non-favourite', { fav: false }, []],
    ])('%s', async (_label, body, tagIds) => {
        const created = await createGroup(body);
        for (const tagId of tagIds) {
            await assignGroupTag(created.id, tagId);
        }

        const first = await clientResolve();
        expect(first.urls).toContain('/api/groups/batch');
        const record = cachedGroupRecord(created.id);
        expect(record).toBeDefined();

        const server = (await serverGroupHashes()).get(created.id);
        expect({ fav: record.hashes.fav, tagIds: record.hashes.tagIds, content: record.hashes.content }).toEqual(server);

        const second = await clientResolve();
        expect(second.urls).not.toContain('/api/groups/batch');
        expect(second.groups.get(created.id)).toEqual(first.groups.get(created.id));
    }, 30000);

    test('the cached group is exactly what /api/groups/batch sent: the stored group plus the stamped id/fav/tag_ids and the request\'s chat_id/chats', async () => {
        const created = await createGroup({ fav: true });
        await assignGroupTag(created.id, 'tag-a');
        await clientResolve();

        const [batched] = await postJson('/api/groups/batch', { ids: [created.id] });
        const file = await readGroupFile(created.id);
        expect(cachedGroupRecord(created.id).group).toEqual(batched);
        expect(batched).toMatchObject({ ...file, id: created.id, fav: true, tag_ids: ['tag-a'] });
        // chat_id and chats aren't stored: they are the requesting tab's (its session, the group's chat list).
        expect(file.chat_id).toBeUndefined();
        expect(file.chats).toBeUndefined();
        expect(typeof batched.chat_id).toBe('string');
        expect(Array.isArray(batched.chats)).toBe(true);
        expect(groupContentFingerprint(batched)).toEqual(groupContentFingerprint({ ...file, chat_id: batched.chat_id, chats: batched.chats }));
    }, 30000);
});

/** @param {unknown} value */
function changedValue(value) {
    if (typeof value === 'string') return `${value}-changed`;
    if (typeof value === 'number') return value + 1;
    if (typeof value === 'boolean') return !value;
    if (Array.isArray(value)) return [...value, 'changed'];
    return 'changed';
}

describe('no false hit: a changed group field changes the server digest, and the client refetches', () => {
    // Every field POST /api/groups/create writes, plus one it doesn't.
    const FIELDS = [
        'name', 'members', 'allow_self_responses', 'activation_strategy', 'generation_mode', 'disabled_members',
        'fav', 'chat_id', 'chats', 'auto_mode_delay', 'generation_mode_join_prefix', 'generation_mode_join_suffix',
        'extra_field',
    ];

    test('FIELDS covers every field of a created group except id', async () => {
        const created = await createGroup({});
        const [batched] = await postJson('/api/groups/batch', { ids: [created.id] });
        expect(Object.keys(batched).filter(k => k !== 'id' && k !== 'tag_ids').sort()).toEqual(FIELDS.filter(f => f !== 'extra_field').sort());
    });

    test.each(FIELDS)('%s', async (field) => {
        const created = await createGroup({ fav: false });
        await clientResolve();
        const before = (await serverGroupHashes()).get(created.id);

        const [file] = await postJson('/api/groups/batch', { ids: [created.id] });
        const edited = { ...file, [field]: changedValue(file[field]) };
        expect(await postJson('/api/groups/edit', edited)).toEqual({ ok: true });

        // chat_id and chats aren't stored: a `chats` write is ignored, and a `chat_id` naming no chat moves the tab
        // nowhere, so neither changes the group.
        const stored = field !== 'chat_id' && field !== 'chats';
        const after = (await serverGroupHashes()).get(created.id);
        expect({ changed: JSON.stringify(after) !== JSON.stringify(before) }).toEqual({ changed: stored });
        expect(after.content !== before.content).toBe(stored && field !== 'fav');

        const resolved = await clientResolve();
        expect(resolved.urls.includes('/api/groups/batch')).toBe(stored);
        expect(resolved.groups.get(created.id)[field]).toEqual(stored ? edited[field] : file[field]);
    }, 30000);

    test('tag assignment', async () => {
        const created = await createGroup({});
        await clientResolve();
        await assignGroupTag(created.id, 'tag-a');

        const resolved = await clientResolve();
        expect(resolved.urls).toContain('/api/groups/batch');
        expect(resolved.groups.get(created.id).tag_ids).toEqual(['tag-a']);
    }, 30000);
});
