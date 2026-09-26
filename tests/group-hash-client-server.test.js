import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { groupDigestContentHash, groupContentFingerprint } from '../public/scripts/hash-utils.js';

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

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/groups.js')} */
let groupsModule;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {typeof fetch} */
const realFetch = globalThis.fetch;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    groupsModule = await import('../src/endpoints/groups.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    Database = (await import('better-sqlite3')).default;
    const { router: charactersRouter } = await import('../src/endpoints/characters.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/groups', groupsModule.router);
    app.use('/api/characters', charactersRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-group-hash-client-server-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
        backups: path.join(tempDir, 'backups'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats, directories.backups]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    localforageStores.clear();
    // The client issues root-relative URLs; route them to the test server.
    globalThis.fetch = jest.fn((url, init) => realFetch(`${baseUrl}${url}`, init));
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
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

/** @param {string} id @returns {object} */
function readGroupFile(id) {
    return JSON.parse(fs.readFileSync(path.join(directories.groups, `${id}.json`), 'utf8'));
}

/** @param {string} id @returns {{ digest_fav: number|null, digest_tag_ids: number|null, digest_content: number|null }} */
function readDigestColumns(id) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'), { readonly: true });
    try {
        return db.prepare('SELECT digest_fav, digest_tag_ids, digest_content FROM groups WHERE id = ?').get(id);
    } finally {
        db.close();
    }
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
        ['tagged favourite (stored digests)', { fav: true }, ['tag-b', 'tag-a']],
        ['untagged non-favourite (NULL digest_tag_ids, file fallback)', { fav: false }, []],
    ])('%s', async (_label, body, tagIds) => {
        const created = await createGroup(body);
        for (const tagId of tagIds) {
            expect(await metadataDb.assignEntityTag(directories, created.id, tagId)).toBe('ok');
        }
        expect(readDigestColumns(created.id).digest_tag_ids === null).toBe(tagIds.length === 0);

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

    test('the cached group is exactly what /api/groups/batch sent: the file plus the stamped id/fav/tag_ids, no live fields', async () => {
        const created = await createGroup({ fav: true });
        await metadataDb.assignEntityTag(directories, created.id, 'tag-a');
        await clientResolve();

        const [batched] = await postJson('/api/groups/batch', { ids: [created.id] });
        const file = readGroupFile(created.id);
        expect(cachedGroupRecord(created.id).group).toEqual(batched);
        expect(batched).toEqual({ ...file, id: created.id, fav: true, tag_ids: ['tag-a'] });
        expect(groupContentFingerprint(batched)).toEqual(groupContentFingerprint(file));
    }, 30000);
});

describe('server digest_content is the hash of the group file as written', () => {
    test('writeGroupFile with a value JSON serializes differently from memory', async () => {
        await groupsModule.writeGroupFile(directories, { id: 'g1', name: 'G', members: ['a.png', undefined], chats: [] });
        expect(readDigestColumns('g1').digest_content >>> 0).toBe(groupDigestContentHash(readGroupFile('g1')) >>> 0);
    });
});

/** @param {unknown} value */
function changedValue(value) {
    if (typeof value === 'string') return `${value}-changed`;
    if (typeof value === 'number') return value + 1;
    if (typeof value === 'boolean') return !value;
    if (Array.isArray(value)) return [...value, 'changed'];
    return 'changed';
}

describe('no false hit: a changed group file field changes the server digest, and the client refetches', () => {
    // Every field POST /api/groups/create writes, plus one it doesn't.
    const FIELDS = [
        'name', 'members', 'allow_self_responses', 'activation_strategy', 'generation_mode', 'disabled_members',
        'fav', 'chat_id', 'chats', 'auto_mode_delay', 'generation_mode_join_prefix', 'generation_mode_join_suffix',
        'extra_field',
    ];

    test('FIELDS covers every field of a created group file except id', async () => {
        const created = await createGroup({});
        expect(Object.keys(readGroupFile(created.id)).filter(k => k !== 'id').sort()).toEqual(FIELDS.filter(f => f !== 'extra_field').sort());
    });

    test.each(FIELDS)('%s', async (field) => {
        const created = await createGroup({ fav: false });
        await clientResolve();
        const before = (await serverGroupHashes()).get(created.id);

        const file = readGroupFile(created.id);
        const edited = { ...file, [field]: changedValue(file[field]) };
        expect(await postJson('/api/groups/edit', edited)).toEqual({ ok: true });

        const after = (await serverGroupHashes()).get(created.id);
        expect(after).not.toEqual(before);
        expect(after.content !== before.content).toBe(field !== 'fav');

        const resolved = await clientResolve();
        expect(resolved.urls).toContain('/api/groups/batch');
        expect(resolved.groups.get(created.id)[field]).toEqual(edited[field]);
    }, 30000);

    test('tag assignment', async () => {
        const created = await createGroup({});
        await clientResolve();
        await metadataDb.assignEntityTag(directories, created.id, 'tag-a');

        const resolved = await clientResolve();
        expect(resolved.urls).toContain('/api/groups/batch');
        expect(resolved.groups.get(created.id).tag_ids).toEqual(['tag-a']);
    }, 30000);
});

/** @param {string} sql */
function runRawSql(sql) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    try {
        db.exec(sql);
    } finally {
        db.close();
    }
}

describe('writeGroupFile() fails safe: whichever step fails, the client never gets a hit on content the file no longer holds', () => {
    const STEPS = [
        {
            step: 'clearing digest_content',
            inject: () => runRawSql('CREATE TRIGGER inject_failure BEFORE UPDATE OF digest_content ON groups WHEN NEW.digest_content IS NULL BEGIN SELECT RAISE(ABORT, \'injected\'); END;'),
            restore: () => runRawSql('DROP TRIGGER inject_failure;'),
            writeRejects: true,
            fileChanged: false,
            digestNull: false,
            miss: false,
        },
        {
            step: 'writing the file',
            inject: () => fs.chmodSync(directories.groups, 0o555),
            restore: () => fs.chmodSync(directories.groups, 0o755),
            writeRejects: true,
            fileChanged: false,
            // NULL is recomputed from the unchanged file, so this is a hit on the file's actual content.
            digestNull: true,
            miss: false,
        },
        {
            step: 'setting the new digest',
            inject: () => runRawSql('CREATE TRIGGER inject_failure BEFORE UPDATE ON groups WHEN NEW.digest_content IS NOT NULL BEGIN SELECT RAISE(ABORT, \'injected\'); END;'),
            restore: () => runRawSql('DROP TRIGGER inject_failure;'),
            writeRejects: false,
            fileChanged: true,
            digestNull: true,
            miss: true,
        },
    ];

    test.each(STEPS)('$step', async ({ inject, restore, writeRejects, fileChanged, digestNull, miss }) => {
        const created = await createGroup({ members: ['a.png'] });
        await clientResolve();
        const before = readGroupFile(created.id);

        inject();
        let rejected;
        try {
            rejected = await groupsModule.writeGroupFile(directories, { ...before, members: ['a.png', 'b.png'] }).then(() => false, () => true);
        } finally {
            restore();
        }
        expect(rejected).toBe(writeRejects);

        const file = readGroupFile(created.id);
        expect(file.members).toEqual(fileChanged ? ['a.png', 'b.png'] : ['a.png']);
        expect(readDigestColumns(created.id).digest_content === null).toBe(digestNull);

        const first = await clientResolve();
        expect(first.urls.includes('/api/groups/batch')).toBe(miss);
        expect(first.groups.get(created.id).members).toEqual(file.members);

        // Whatever digest the failure left, the next resolve hits on the file's current content.
        const second = await clientResolve();
        expect(second.urls).not.toContain('/api/groups/batch');
        expect(second.groups.get(created.id).members).toEqual(file.members);
    }, 30000);
});
