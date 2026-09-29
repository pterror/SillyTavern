import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import lodash from 'lodash';

// `/query`'s `filter.group`, the character list's Groups filter (upstream's FILTER_TYPES.GROUP): `true` keeps only
// groups, `false` only characters. Rows keep the shape `filter.includeGroups` asks for, and `want: 'hidden'` still
// counts every entity, as upstream's "N hidden" does. Checked in JSON, in hash mode (through the real client
// repository) and with a search term.

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
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'query-group-filter-test-user' }));
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-query-group-filter-test-'));
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

/** @param {string} id @param {{ name?: string, fav?: boolean }} [options] */
async function seedGroup(id, { name = id, fav = false } = {}) {
    const group = { id, name, members: [], chats: [], fav };
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

/** Repeats the request until the search indexes have caught up: two answers in a row agree. */
async function settledQuery(body) {
    let previous = JSON.stringify(await queryJson(body));
    const deadline = Date.now() + 10000;
    for (;;) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const next = await queryJson(body);
        if (JSON.stringify(next) === previous || Date.now() > deadline) return next;
        previous = JSON.stringify(next);
    }
}

/** @param {any} row */
const rowKey = row => {
    const { type, item } = repositoryModule.normalizeQueryRow(row);
    return type === 'group' ? `group:${item.id}` : item.avatar;
};

/** Five characters (two favs) and two groups (one fav). */
async function seedLibrary() {
    for (const [avatar, fav] of [['A.png', true], ['B.png', true], ['C.png', false], ['D.png', false], ['E.png', false]]) {
        await seedCharacter(avatar, { fav });
    }
    await seedGroup('g1', { fav: true });
    await seedGroup('g2', { fav: false });
}

const NAME_ASC = { field: 'name', order: 'asc' };

describe('/query filter.group', () => {
    test('JSON: only groups, or only characters, in the includeGroups row shape; hidden counts every entity', async () => {
        await seedLibrary();

        const groups = await queryJson({ filter: { includeGroups: true, group: true }, sort: NAME_ASC, page: 1, pageSize: 1, want: ['rows', 'total', 'hidden'] });
        expect(groups.rows).toEqual([{ type: 'group', item: expect.objectContaining({ id: 'g1' }) }]);
        expect(groups).toMatchObject({ total: 2, hidden: 6 });

        const characters = await queryJson({ filter: { includeGroups: true, group: false }, sort: NAME_ASC, page: 1, pageSize: 10, want: ['rows', 'total', 'hidden'] });
        expect(characters.rows.map(row => row.type)).toEqual(['character', 'character', 'character', 'character', 'character']);
        expect(characters.rows.map(rowKey)).toEqual(['A.png', 'B.png', 'C.png', 'D.png', 'E.png']);
        expect(characters).toMatchObject({ total: 5, hidden: 2 });

        // With the other filters.
        const favGroups = await queryJson({ filter: { includeGroups: true, group: true, fav: true }, sort: NAME_ASC, page: 1, pageSize: 10, want: ['rows', 'total'] });
        expect(favGroups.rows.map(rowKey)).toEqual(['group:g1']);
        expect(favGroups.total).toBe(1);
        const favCharacters = await queryJson({ filter: { includeGroups: true, group: false, fav: true }, sort: NAME_ASC, page: 1, pageSize: 10, want: ['rows', 'total'] });
        expect(favCharacters.rows.map(rowKey)).toEqual(['A.png', 'B.png']);
        expect(favCharacters.total).toBe(2);

        // No Groups filter: both kinds.
        const both = await queryJson({ filter: { includeGroups: true }, sort: NAME_ASC, page: 1, pageSize: 10, want: ['rows', 'total'] });
        expect(both.rows.map(rowKey)).toEqual(['A.png', 'B.png', 'C.png', 'D.png', 'E.png', 'group:g1', 'group:g2']);
        expect(both.total).toBe(7);

        // Only characters, without groups asked for: the plain characters-only list.
        const plain = await queryJson({ filter: { group: false }, sort: NAME_ASC, page: 1, pageSize: 10, want: ['rows', 'total'] });
        expect(plain.rows.map(row => row.avatar)).toEqual(['A.png', 'B.png', 'C.png', 'D.png', 'E.png']);

        const response = await realFetch(`${baseUrl}/api/characters/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filter: { group: true }, sort: NAME_ASC }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ reason: 'group-requires-include-groups' });
    }, 30000);

    test('hash mode through the client repository, and from its unchanged cache', async () => {
        await seedLibrary();
        const repository = new repositoryModule.CharacterRepository(/** @type {any} */ ({ get: () => undefined, has: () => false, onChange: () => noop }));

        for (let round = 0; round < 2; round++) {
            const groups = await repository.query({ includeGroups: true, group: true }, NAME_ASC, 1, 10, ['rows', 'total', 'hidden']);
            expect(groups.rows.map(rowKey)).toEqual(['group:g1', 'group:g2']);
            expect(groups).toMatchObject({ total: 2, hidden: 5 });

            const characters = await repository.query({ includeGroups: true, group: false }, NAME_ASC, 1, 3, ['rows', 'total', 'hidden']);
            expect(characters.rows.map(row => row.type)).toEqual(['character', 'character', 'character']);
            expect(characters.rows.map(rowKey)).toEqual(['A.png', 'B.png', 'C.png']);
            expect(characters).toMatchObject({ total: 5, hidden: 4 });
        }
    }, 30000);

    test.each([
        ['name order', NAME_ASC],
        ['relevance order', { field: 'search' }],
    ])('with a search term, in %s', async (_, sort) => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;
        // Names differ in their first letters: a search's name order compares only a short prefix.
        await seedCharacter('Vlad.png', { name: 'Vlad the Vampire', file: true });
        await seedCharacter('Anna.png', { name: 'Anna the Vampire', file: true });
        await seedCharacter('Human.png', { name: 'Human', file: true });
        await seedGroup('g1', { name: 'Vampire Coven' });
        await seedGroup('g2', { name: 'Book Club' });

        const both = await settledQuery({ filter: { search: 'vampire', includeGroups: true }, sort, page: 1, pageSize: 10, want: ['rows'] });
        expect(both.rows.map(rowKey).sort()).toEqual(['Anna.png', 'Vlad.png', 'group:g1']);

        const groups = await settledQuery({ filter: { search: 'vampire', includeGroups: true, group: true }, sort, page: 1, pageSize: 10, want: ['rows', 'hidden'] });
        expect(groups.rows.map(rowKey)).toEqual(['group:g1']);
        expect(groups.hidden).toBe(4);

        const characters = await settledQuery({ filter: { search: 'vampire', includeGroups: true, group: false }, sort, page: 1, pageSize: 10, want: ['rows', 'hidden'] });
        expect(characters.rows.map(row => row.type)).toEqual(['character', 'character']);
        expect(characters.rows.map(rowKey).sort()).toEqual(['Anna.png', 'Vlad.png']);
        expect(characters.hidden).toBe(3);
    }, 30000);
});
