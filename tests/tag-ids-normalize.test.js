import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// tag_ids is sent sorted (JS string order), and [] when there are none, by the server, and stored that way by the
// client caches - so records holding the same tags hold equal tag_ids.

const USER_HANDLE = 'tag-ids-normalize-test-user';

/** @type {Map<string, Map<string, any>>} localforage instance name -> key -> record */
const localforageStores = new Map();

jest.unstable_mockModule('../public/lib.js', () => ({
    localforage: {
        createInstance: ({ name }) => {
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
            };
        },
    },
}));
jest.unstable_mockModule('../public/scripts/user.js', () => ({
    getCurrentUserHandle: () => USER_HANDLE,
}));

// SQLite's ORDER BY compares UTF-8 bytes and JS sort UTF-16 code units; these two ids order differently under
// each (SQLite: HIGH_BMP first, JS: ASTRAL first), so they tell a JS-sorted list from a SQL-ordered one.
const HIGH_BMP = 'tag\uE000';
const ASTRAL = 'tag\u{10000}';
const JS_SORTED = [ASTRAL, HIGH_BMP];

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {typeof import('../public/scripts/character-cache.js')} */
let characterCache;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
const originalCwd = process.cwd();

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    characterCache = await import('../public/scripts/character-cache.js');
    const { router: charactersRouter } = await import('../src/endpoints/characters.js');

    // /create reads the default avatar relative to the repo root.
    process.chdir(path.resolve(originalCwd, '..'));

    const express = (await import('express')).default;
    const multer = (await import('multer')).default;
    const app = express();
    app.use(multer({ dest: fs.mkdtempSync(path.join(os.tmpdir(), 'st-tag-ids-normalize-uploads-')) }).single('avatar'));
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/characters', charactersRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    process.chdir(originalCwd);
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tag-ids-normalize-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
        thumbnailsAvatar: path.join(tempDir, 'thumbnails', 'avatar'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats, directories.thumbnailsAvatar]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    // character-cache.js keeps its store instances, so each one's records are emptied rather than dropped.
    for (const records of localforageStores.values()) records.clear();
});

afterEach(async () => {
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

async function postJson(urlPath, body) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
}

/** @param {string} name */
function card(name) {
    return JSON.stringify({ name, data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { world: '' } } });
}

/** The character's list row, as the store reads it. @param {string} id */
async function readListRow(id) {
    return /** @type {any} */ (await metadataDb.getShallowByIds(directories, [id]))[id];
}

/** @param {string} id @param {string[]} tagIds */
async function assignTags(id, tagIds) {
    for (const tagId of tagIds) expect(await metadataDb.assignEntityTag(directories, id, tagId)).toBe('ok');
}

describe('server: list rows\' tag_ids are read sorted', () => {
    test('tags assigned in any order', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', card('Bob'));
        await assignTags('Bob.png', ['tb', 'ta', 'tc']);
        expect((await readListRow('Bob.png')).tag_ids).toEqual(['ta', 'tb', 'tc']);

        const [fields] = await postJson('/api/characters/batch', { avatars: ['Bob.png'], fields: ['tag_ids'] });
        expect(fields.tag_ids).toEqual(['ta', 'tb', 'tc']);
    });

    test('a batch-import row tagged while still buffered', async () => {
        await metadataDb.beginBatchImport(directories);
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', card('Bob'), null, null, { fromImport: true });
        await assignTags('Bob.png', ['tb', 'ta']);
        await metadataDb.endBatchImport(directories);
        expect((await readListRow('Bob.png')).tag_ids).toEqual(['ta', 'tb']);
    });

    test('ids SQLite and JS order differently are stored in JS order', async () => {
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', card('Bob'));
        await assignTags('Bob.png', [HIGH_BMP, ASTRAL]);
        expect((await readListRow('Bob.png')).tag_ids).toEqual(JS_SORTED);
    });
});

describe('server: every route sending tag_ids sends them sorted', () => {
    test('characters: /batch, /batch fields and /get', async () => {
        const created = await fetch(`${baseUrl}/api/characters/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ch_name: 'Zorkmid', file_name: 'Zorkmid', description: 'd' }),
        });
        expect(await created.text()).toBe('Zorkmid.png');
        await assignTags('Zorkmid.png', [HIGH_BMP, ASTRAL]);

        const [full] = await postJson('/api/characters/batch', { avatars: ['Zorkmid.png'] });
        expect(full.tag_ids).toEqual(JS_SORTED);
        const [fields] = await postJson('/api/characters/batch', { avatars: ['Zorkmid.png'], fields: ['tag_ids'] });
        expect(fields.tag_ids).toEqual(JS_SORTED);
        const got = await postJson('/api/characters/get', { avatar_url: 'Zorkmid.png' });
        expect(got.tag_ids).toEqual(JS_SORTED);
    });
});

describe('client: the caches store tag_ids sorted, and [] when absent', () => {
    const CHARACTER_STORE = `SillyTavern_CharacterCache_${USER_HANDLE}`;
    const GROUP_STORE = `SillyTavern_GroupCache_${USER_HANDLE}`;

    test('saveCachedCharacters() stores a sorted copy without touching the caller\'s object, at hash version 5', async () => {
        const unsorted = { avatar: 'Bob.png', name: 'Bob', tag_ids: ['tb', 'ta'] };
        const absent = { avatar: 'Ann.png', name: 'Ann' };
        await characterCache.saveCachedCharacters([{ avatar: 'Bob.png', character: unsorted }, { avatar: 'Ann.png', character: absent }]);

        expect(unsorted.tag_ids).toEqual(['tb', 'ta']);
        expect('tag_ids' in absent).toBe(false);
        const entries = await characterCache.getCachedEntriesByIds(['Bob.png', 'Ann.png']);
        expect(entries.get('Bob.png').character.tag_ids).toEqual(['ta', 'tb']);
        expect(entries.get('Ann.png').character.tag_ids).toEqual([]);
        expect(entries.get('Bob.png').hashes.v).toBe(5);
    });

    test('a character record from an earlier hash version reads as a miss', async () => {
        await characterCache.saveCachedCharacters([{ avatar: 'Bob.png', character: { avatar: 'Bob.png', name: 'Bob', tag_ids: ['tb', 'ta'] } }]);
        const store = localforageStores.get(CHARACTER_STORE);
        const record = store.get('Bob.png');
        store.set('Bob.png', { ...record, hashes: { ...record.hashes, v: 3 } });
        expect((await characterCache.getCachedEntriesByIds(['Bob.png'])).has('Bob.png')).toBe(false);
    });

    test('saveCachedGroups() stores a sorted copy without touching the caller\'s object, at hash version 3', async () => {
        const unsorted = { id: 'g1', name: 'G1', members: [], tag_ids: [HIGH_BMP, ASTRAL] };
        const absent = { id: 'g2', name: 'G2', members: [] };
        await characterCache.saveCachedGroups([{ id: 'g1', group: unsorted }, { id: 'g2', group: absent }]);

        expect(unsorted.tag_ids).toEqual([HIGH_BMP, ASTRAL]);
        expect('tag_ids' in absent).toBe(false);
        const entries = await characterCache.getCachedGroupEntriesByIds(['g1', 'g2']);
        expect(entries.get('g1').group.tag_ids).toEqual(JS_SORTED);
        expect(entries.get('g2').group.tag_ids).toEqual([]);
        expect(entries.get('g1').hashes.v).toBe(3);
    });

    test('a group record from an earlier hash version reads as a miss', async () => {
        await characterCache.saveCachedGroups([{ id: 'g1', group: { id: 'g1', name: 'G1', tag_ids: [] } }]);
        const store = localforageStores.get(GROUP_STORE);
        const record = store.get('g1');
        store.set('g1', { ...record, hashes: { ...record.hashes, v: 2 } });
        expect((await characterCache.getCachedGroupEntriesByIds(['g1'])).has('g1')).toBe(false);
    });
});
