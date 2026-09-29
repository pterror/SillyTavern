import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import lodash from 'lodash';

// `/query`'s `want: 'hidden'`: how many entities the filter leaves out, which the character list's "N hidden" badge
// shows. The same on every page, in JSON and in hash mode (through the real client repository).

const originalCwd = process.cwd();
const noop = () => {};

function createFakeLocalforageInstance() {
    const records = new Map();
    return {
        getItem: async key => (records.has(key) ? structuredClone(records.get(key)) : null),
        setItem: async (key, value) => { records.set(key, structuredClone(value)); return value; },
        removeItem: async key => { records.delete(key); },
        clear: async () => { records.clear(); },
        keys: async () => [...records.keys()],
        iterate: async () => {},
    };
}

jest.unstable_mockModule('../public/lib.js', () => ({
    lodash,
    localforage: { createInstance: createFakeLocalforageInstance },
}));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'query-hidden-count-test-user' }));
jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));
jest.unstable_mockModule('../public/scripts/character-store.js', () => ({
    characters: [],
    charactersStore: { get: () => undefined, has: () => false, onChange: () => noop },
}));
jest.unstable_mockModule('../public/script.js', () => ({ unshallowCharacter: async () => {} }));

const realFetch = globalThis.fetch;

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {typeof import('../src/endpoints/search-engine.js')} */
let searchEngine;
/** @type {typeof import('../public/scripts/character-repository.js')} */
let repositoryModule;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {any} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    searchEngine = await import('../src/endpoints/search-engine.js');
    const { router } = await import('../src/endpoints/characters.js');
    const groupsModule = await import('../src/endpoints/groups.js');
    repositoryModule = await import('../public/scripts/character-repository.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/characters', router);
    app.use('/api/groups', groupsModule.router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-query-hidden-count-test-'));
    directories = {
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'groupChats'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    globalThis.fetch = jest.fn((url, init) => realFetch(String(url).startsWith('/') ? `${baseUrl}${url}` : url, init));
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/**
 * @param {string} avatar
 * @param {{ name?: string, fav?: boolean, file?: boolean }} [options] file: also write the PNG, which search indexes.
 */
async function seedCharacter(avatar, { name = avatar.replace(/\.png$/, ''), fav = false, file = false } = {}) {
    const card = JSON.stringify({
        name, fav, spec: 'chara_card_v2', spec_version: '2.0',
        data: {
            name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav, world: '' },
        },
    });
    if (file) {
        const image = await fs.promises.readFile(path.join(originalCwd, '..', 'public', 'img', 'ai4.png'));
        await fs.promises.writeFile(path.join(directories.characters, avatar), cardParser.write(image, card));
    }
    await metadataDb.upsertCharacterFromWrite(directories, avatar, card);
}

/** @param {string} id @param {boolean} fav */
async function seedGroup(id, fav) {
    const group = { id, name: id, members: [], chats: [], fav };
    await metadataDb.writeGroupFileAndRow(directories, group, () => fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group)));
}

/** @param {object} body */
async function queryJson(body) {
    const response = await realFetch(`${baseUrl}/api/characters/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
}

/** Five characters (two favs) and two groups (one fav). */
async function seedLibrary() {
    for (const [avatar, fav] of [['A.png', true], ['B.png', true], ['C.png', false], ['D.png', false], ['E.png', false]]) {
        await seedCharacter(avatar, { fav });
    }
    await seedGroup('g1', true);
    await seedGroup('g2', false);
}

const NAME_ASC = { field: 'name', order: 'asc' };

describe('/query want: hidden', () => {
    test('JSON: every entity less the matches, the same on every page', async () => {
        await seedLibrary();
        for (const page of [1, 2, 3]) {
            const withGroups = await queryJson({ filter: { fav: true, includeGroups: true }, sort: NAME_ASC, page, pageSize: 1, want: ['rows', 'hidden'] });
            expect(withGroups).toMatchObject({ total: 3, hidden: 4 });
            const charactersOnly = await queryJson({ filter: { fav: true }, sort: NAME_ASC, page, pageSize: 1, want: ['rows', 'total', 'hidden'] });
            expect(charactersOnly).toMatchObject({ total: 2, hidden: 3 });
        }
        const unfiltered = await queryJson({ filter: { includeGroups: true }, sort: NAME_ASC, page: 1, pageSize: 2, want: ['rows', 'total', 'hidden'] });
        expect(unfiltered).toMatchObject({ total: 7, hidden: 0 });

        const without = await queryJson({ filter: { fav: true, includeGroups: true }, sort: NAME_ASC, page: 1, pageSize: 1, want: ['rows', 'total'] });
        expect(without).not.toHaveProperty('hidden');
    }, 30000);

    test('hash mode through the client repository, on every page and from its unchanged cache', async () => {
        await seedLibrary();
        const repository = new repositoryModule.CharacterRepository(/** @type {any} */ ({ get: () => undefined, has: () => false, onChange: () => noop }));
        const filter = { fav: false, includeGroups: true };
        for (const page of [1, 2]) {
            const result = await repository.query(filter, NAME_ASC, page, 2, ['rows', 'total', 'hidden']);
            expect(result).toMatchObject({ total: 4, hidden: 3 });
        }
        // The repeat is answered `unchanged` and served from the cached response.
        const repeat = await repository.query(filter, NAME_ASC, 1, 2, ['rows', 'total', 'hidden']);
        expect(repeat).toMatchObject({ total: 4, hidden: 3 });
        expect(repeat.rows).toHaveLength(2);

        const without = await repository.query(filter, NAME_ASC, 1, 2, ['rows', 'total']);
        expect(without.hidden).toBeUndefined();
        expect(without.rows).toHaveLength(2);
    }, 30000);

    test('an estimated total gives an estimated hidden count', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;
        for (let i = 0; i < 20; i++) {
            await seedCharacter(`v${String(i).padStart(2, '0')}.png`, { name: `Vampire ${i}`, file: true });
        }
        await seedCharacter('Human.png', { name: 'Human', file: true });
        const body = { filter: { search: 'vampire', includeGroups: true }, sort: { field: 'search' }, page: 1, pageSize: 2, want: ['rows', 'total', 'hidden'] };

        // Repeats until the search index has caught up.
        let answer;
        const deadline = Date.now() + 10000;
        do {
            answer = await queryJson(body);
            if (typeof answer.total === 'string') break;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);

        // A relevance page counts only the matches it ranked (2 + 5 over-fetched).
        expect(answer.total).toBe('~7');
        expect(answer.hidden).toBe('~14');
    }, 30000);
});
