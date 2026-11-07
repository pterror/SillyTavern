import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

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

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
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

    fixture = await import('./converted-user.fixture.js');
    cardParser = await import('../src/character-card-parser.js');
    const { router } = await import('../src/endpoints/characters.js');
    const groupsModule = await import('../src/endpoints/groups.js');
    repositoryModule = await import('../public/scripts/character-repository.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', router);
    app.use('/api/groups', groupsModule.router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-query-hidden-count-test-');
    directories = user.directories;
    globalThis.DATA_ROOT = user.dataRoot;
    globalThis.fetch = jest.fn((url, init) => realFetch(String(url).startsWith('/') ? `${baseUrl}${url}` : url, init));
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    await user.close();
});

/**
 * @param {string} avatar
 * @param {{ name?: string, fav?: boolean, file?: boolean }} [options]
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
        await fixture.writeCardWithImage(user, avatar, card, cardParser.write(image, card));
        return;
    }
    await user.store.lib.writeCard(directories, avatar, card);
}

/**
 * @param {string} id
 * @param {boolean} fav
 */
async function seedGroup(id, fav) {
    const group = { id, name: id, members: [], chats: [], fav };
    await user.store.lib.writeGroup(group);
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

async function seedLibrary() {
    for (const [avatar, fav] of [['A.png', true], ['B.png', true], ['C.png', false], ['D.png', false], ['E.png', false]]) {
        await seedCharacter(avatar, { fav });
    }
    await seedGroup('g1', true);
    await seedGroup('g2', false);
}

const NAME_ASC = { field: 'name', order: 'asc' };

describe('/query want: hidden', () => {
    test('JSON: every entity less the rows on this page', async () => {
        await seedLibrary();
        for (const [page, rows, hidden] of [[1, 2, 5], [2, 1, 6], [3, 0, 7]]) {
            const withGroups = await queryJson({ filter: { fav: true, includeGroups: true }, sort: NAME_ASC, page, pageSize: 2, want: ['rows', 'hidden'] });
            expect(withGroups.rows).toHaveLength(rows);
            expect(withGroups).toMatchObject({ hidden });
            expect(withGroups.total).toBeUndefined();
        }
        for (const [page, hidden] of [[1, 4], [2, 4]]) {
            const charactersOnly = await queryJson({ filter: { fav: true }, sort: NAME_ASC, page, pageSize: 1, want: ['rows', 'total', 'hidden'] });
            expect(charactersOnly).toMatchObject({ total: 2, hidden });
        }
        const unfiltered = await queryJson({ filter: { includeGroups: true }, sort: NAME_ASC, page: 1, pageSize: 2, want: ['rows', 'total', 'hidden'] });
        expect(unfiltered).toMatchObject({ total: 7, hidden: 5 });
        const noRows = await queryJson({ filter: { fav: true, includeGroups: true }, sort: NAME_ASC, page: 1, pageSize: 2, want: ['total', 'hidden'] });
        expect(noRows).toMatchObject({ total: 3, hidden: 7 });

        const without = await queryJson({ filter: { fav: true, includeGroups: true }, sort: NAME_ASC, page: 1, pageSize: 1, want: ['rows', 'total'] });
        expect(without).not.toHaveProperty('hidden');
    }, 30000);

    test('hash mode through the client repository, on every page and from its unchanged cache', async () => {
        await seedLibrary();
        const repository = new repositoryModule.CharacterRepository(/** @type {any} */ ({ get: () => undefined, has: () => false, onChange: () => noop }));
        const filter = { fav: false, includeGroups: true };
        for (const [page, rows, hidden] of [[1, 3, 4], [2, 1, 6]]) {
            const result = await repository.query(filter, NAME_ASC, page, 3, ['rows', 'total', 'hidden']);
            expect(result.rows).toHaveLength(rows);
            expect(result).toMatchObject({ total: 4, hidden });
        }
        const repeat = await repository.query(filter, NAME_ASC, 1, 3, ['rows', 'total', 'hidden']);
        expect(repeat).toMatchObject({ total: 4, hidden: 4 });
        expect(repeat.rows).toHaveLength(3);

        const without = await repository.query(filter, NAME_ASC, 1, 2, ['rows', 'total']);
        expect(without.hidden).toBeUndefined();
        expect(without.rows).toHaveLength(2);
    }, 30000);

    test('a relevance page past its listed rows counts every match and the hidden count stays exact', async () => {
        for (let i = 0; i < 20; i++) {
            await seedCharacter(`v${String(i).padStart(2, '0')}.png`, { name: `Vampire ${i}`, file: true });
        }
        await seedCharacter('Human.png', { name: 'Human', file: true });
        const body = { filter: { search: 'vampire', includeGroups: true }, sort: { field: 'search' }, page: 1, pageSize: 2, want: ['rows', 'total', 'hidden'] };

        let answer;
        const deadline = Date.now() + 10000;
        do {
            answer = await queryJson(body);
            if (answer.total === 20) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);

        expect(answer.total).toBe(20);
        expect(answer.rows).toHaveLength(2);
        expect(answer.hidden).toBe(19);
    }, 30000);
});
