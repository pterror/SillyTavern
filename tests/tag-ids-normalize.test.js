import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installBrowserStorage } from './util/browser-storage.js';

const USER_HANDLE = 'tag-ids-normalize-test-user';

/** @type {Map<string, Map<string, any>>} */
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

const HIGH_BMP = 'tag\uE000';
const ASTRAL = 'tag\u{10000}';
const JS_SORTED = [ASTRAL, HIGH_BMP];

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
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

    fixture = await import('./converted-user.fixture.js');
    characterCache = await import('../public/scripts/character-cache.js');
    const { router: charactersRouter } = await import('../src/endpoints/characters.js');

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

beforeEach(async () => {
    user = await fixture.emptyUser('st-tag-ids-normalize-test-');
    directories = user.directories;
    globalThis.DATA_ROOT = user.dataRoot;
    for (const records of localforageStores.values()) records.clear();
});

afterEach(() => user.close());

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

/** @param {string} id */
async function readListRow(id) {
    const page = await user.store.lib.query({ ids: [id], wantRows: true, limit: 1 });
    return /** @type {any} */ (page.rows)[0].item;
}

/**
 * @param {string} id
 * @param {string[]} tagIds
 */
async function assignTags(id, tagIds) {
    for (const tagId of tagIds) expect((await user.store.lib.tags.assign(id, tagId)).result).toBe('ok');
}

describe('server: list rows\' tag_ids are read sorted', () => {
    test('tags assigned in any order', async () => {
        await user.store.lib.writeCard(directories, 'Bob.png', card('Bob'));
        await assignTags('Bob.png', ['tb', 'ta', 'tc']);
        expect((await readListRow('Bob.png')).tag_ids).toEqual(['ta', 'tb', 'tc']);

        const [fields] = await postJson('/api/characters/batch', { avatars: ['Bob.png'], fields: ['tag_ids'] });
        expect(fields.tag_ids).toEqual(['ta', 'tb', 'tc']);
    });

    test('a character written in a batch of imports, tagged', async () => {
        user.store.lib.beginBatch();
        try {
            await user.store.lib.writeCard(directories, 'Bob.png', card('Bob'));
            await assignTags('Bob.png', ['tb', 'ta']);
        } finally {
            user.store.lib.endBatch();
        }
        expect((await readListRow('Bob.png')).tag_ids).toEqual(['ta', 'tb']);
    });

    test('ids SQLite and JS order differently are stored in JS order', async () => {
        await user.store.lib.writeCard(directories, 'Bob.png', card('Bob'));
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

describe('client: the row cache stores tag_ids sorted, and [] when absent', () => {
    /** @type {() => void} */
    let restore;
    beforeAll(() => {
        restore = installBrowserStorage({ quota: 1e9 });
    });
    afterAll(() => restore());

    test('keepRows() stores a sorted copy of a character or group row without touching the caller\'s object', async () => {
        const bob = { avatar: 'Bob.png', name: 'Bob', tag_ids: ['tb', 'ta'] };
        const ann = { avatar: 'Ann.png', name: 'Ann' };
        const g1 = { id: 'g1', name: 'G1', members: [], tag_ids: [HIGH_BMP, ASTRAL] };
        const keys = {
            bob: characterCache.characterRowKey({ id: 'Bob.png', version: 1, tagIdsHash: 0 }),
            ann: characterCache.characterRowKey({ id: 'Ann.png', version: 2, tagIdsHash: 0 }),
            g1: characterCache.groupRowKey({ id: 'g1', favHash: 0, tagIdsHash: 0, contentHash: 0 }),
        };
        await characterCache.keepRows([{ key: keys.bob, row: bob }, { key: keys.ann, row: ann }, { key: keys.g1, row: g1 }]);

        expect(bob.tag_ids).toEqual(['tb', 'ta']);
        expect('tag_ids' in ann).toBe(false);
        expect(g1.tag_ids).toEqual([HIGH_BMP, ASTRAL]);
        const kept = await characterCache.readRows(Object.values(keys));
        expect(kept.get(keys.bob).tag_ids).toEqual(['ta', 'tb']);
        expect(kept.get(keys.ann).tag_ids).toEqual([]);
        expect(kept.get(keys.g1).tag_ids).toEqual(JS_SORTED);
    });
});
