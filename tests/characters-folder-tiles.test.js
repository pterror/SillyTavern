import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// POST /api/characters/folder-tiles answers what the character list's folder tiles showed when the browser worked
// them out from every loaded character and group (getFolderTileEntities, filterAndSortEntities, filterByTagState and
// filterTagSubEntities in public/scripts): per tile, the sub-list's size, how many tagged entities it hides, and the
// strip's first rows.

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {typeof import('../src/endpoints/search-engine.js')} */
let searchEngine;
/** @type {typeof import('../src/endpoints/characters.js')} */
let charactersModule;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    charactersModule = await import('../src/endpoints/characters.js');
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    searchEngine = await import('../src/endpoints/search-engine.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/characters', charactersModule.router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-folder-tiles-test-'));
    directories = /** @type {any} */ ({
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(async () => {
    jest.restoreAllMocks();
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @param {object} body */
async function tilesRequest(body) {
    const response = await fetch(`${baseUrl}/api/characters/folder-tiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

/** @param {object} body */
async function tiles(body) {
    const { status, body: json } = await tilesRequest({ sort: { field: 'name', order: 'asc' }, ...body });
    expect(status).toBe(200);
    return json.tiles;
}

/** @param {{ type: string, item: any }} row */
const rowId = row => row.type === 'group' ? `group:${row.item.id}` : row.item.avatar;

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
        const image = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
        await fs.promises.writeFile(path.join(directories.characters, avatar), cardParser.write(image, card));
    }
    await metadataDb.upsertCharacterFromWrite(directories, avatar, card);
}

/** @param {string} id @param {string} name */
async function seedGroup(id, name) {
    const group = { id, name, members: [], chats: [], fav: false };
    await metadataDb.writeGroupFileAndRow(directories, group, () => fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group)));
}

/** @param {string} id @param {string[]} tagIds */
async function tag(id, tagIds) {
    for (const tagId of tagIds) await metadataDb.assignEntityTag(directories, id, tagId);
}

const FOLDERS = [
    { id: 'open', name: 'Open', folder_type: 'OPEN' },
    { id: 'shut', name: 'Shut', folder_type: 'CLOSED' },
    { id: 'shut2', name: 'Shut 2', folder_type: 'CLOSED' },
    { id: 'plain', name: 'Plain' },
];

/**
 * Tagged `open`: A, B (fav), Hidden (also in the closed folder `shut`), and the group Gamma. `shut` also holds
 * Solo. X has no tags.
 */
async function seedFolders() {
    expect(await metadataDb.saveTagDefinitions(directories, FOLDERS)).toBe('ok');
    await seedCharacter('A.png');
    await seedCharacter('B.png', { fav: true });
    await seedCharacter('Hidden.png');
    await seedCharacter('Solo.png');
    await seedCharacter('X.png');
    await seedGroup('g1', 'Gamma');
    await tag('A.png', ['open']);
    await tag('B.png', ['open', 'plain']);
    await tag('Hidden.png', ['open', 'shut']);
    await tag('Solo.png', ['shut']);
    await tag('g1', ['open']);
}

async function makeTagColumnsReady() {
    await metadataDb.fillTagNameKeysIfNeeded(directories);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
    expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(true);
}

describe('POST /api/characters/folder-tiles', () => {
    describe.each([['tag columns filled', true], ['tag columns not filled yet', false]])('%s', (_, ready) => {
        test('a tile counts its tagged entities, leaving out and counting as hidden those in a closed folder', async () => {
            await seedFolders();
            if (ready) await makeTagColumnsReady();
            expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(ready);

            const [open, shut, plain] = await tiles({ tiles: ['open', 'shut', 'plain'], filter: {} });
            expect(open).toEqual({ id: 'open', count: 3, hidden: 1, rows: expect.any(Array) });
            expect(open.rows.map(rowId)).toEqual(['A.png', 'B.png', 'group:g1']);
            expect(open.rows[2].item.name).toBe('Gamma');
            // A closed folder's own tile hides nothing.
            expect(shut).toEqual({ id: 'shut', count: 2, hidden: 0, rows: expect.any(Array) });
            expect(shut.rows.map(rowId)).toEqual(['Hidden.png', 'Solo.png']);
            expect(plain.count).toBe(1);
            expect(plain.hidden).toBe(0);
        });
    });

    test('the list\'s filters narrow each tile, and what they leave out counts as hidden', async () => {
        await seedFolders();
        const open = async (filter) => (await tiles({ tiles: ['open'], filter }))[0];

        expect(await open({ fav: true })).toMatchObject({ count: 1, hidden: 3 });
        expect((await open({ fav: true })).rows.map(rowId)).toEqual(['B.png']);
        expect(await open({ fav: false })).toMatchObject({ count: 2, hidden: 2 });

        // The Groups filter: only groups, or no groups.
        const groupsOnly = await open({ group: true });
        expect(groupsOnly).toMatchObject({ count: 1, hidden: 3 });
        expect(groupsOnly.rows.map(rowId)).toEqual(['group:g1']);
        const [randomGroupsOnly] = await tiles({ tiles: ['open'], filter: { group: true }, sort: { field: 'random', order: 'asc', seed: 3 } });
        expect(randomGroupsOnly).toMatchObject({ count: 1, hidden: 3 });
        expect(randomGroupsOnly.rows.map(rowId)).toEqual(['group:g1']);
        const noGroups = await open({ group: false });
        expect(noGroups).toMatchObject({ count: 2, hidden: 2 });
        expect(noGroups.rows.map(rowId)).toEqual(['A.png', 'B.png']);

        // Every included tag, no excluded one.
        expect((await open({ tags: { include: ['plain'], exclude: [] } })).rows.map(rowId)).toEqual(['B.png']);
        expect((await open({ tags: { include: [], exclude: ['plain'] } })).rows.map(rowId)).toEqual(['A.png', 'group:g1']);

        // A closed folder the list includes (opened) hides nothing.
        const opened = await open({ tags: { include: ['shut'], exclude: [] } });
        expect(opened).toMatchObject({ count: 1, hidden: 3 });
        expect(opened.rows.map(rowId)).toEqual(['Hidden.png']);
    });

    test('any closed folder hides, and only one not marked deleted', async () => {
        await seedFolders();
        await seedCharacter('Other.png');
        await tag('Other.png', ['open', 'shut2']);
        expect(await tiles({ tiles: ['open'], filter: {} })).toMatchObject([{ count: 3, hidden: 2 }]);

        expect(await metadataDb.deleteTagDefinition(directories, 'shut2')).toBe('ok');
        expect(await tiles({ tiles: ['open', 'shut2'], filter: {} })).toMatchObject([{ count: 4, hidden: 1 }, { id: 'shut2', missing: true }]);
    });

    test('the strip holds at most FOLDER_TILE_STRIP_ROWS rows in the sort\'s order, and the count covers the rest', async () => {
        expect(charactersModule.FOLDER_TILE_STRIP_ROWS).toBe(10);
        expect(await metadataDb.saveTagDefinitions(directories, FOLDERS)).toBe('ok');
        const avatars = [];
        for (let i = 0; i < 13; i++) {
            const avatar = `C${String(i).padStart(2, '0')}.png`;
            avatars.push(avatar);
            await seedCharacter(avatar);
            await tag(avatar, ['open']);
        }
        const [asc] = await tiles({ tiles: ['open'], filter: {}, sort: { field: 'name', order: 'asc' } });
        expect(asc.count).toBe(13);
        expect(asc.hidden).toBe(0);
        expect(asc.rows.map(rowId)).toEqual(avatars.slice(0, 10));
        const [desc] = await tiles({ tiles: ['open'], filter: {}, sort: { field: 'name', order: 'desc' } });
        expect(desc.rows.map(rowId)).toEqual(avatars.slice().reverse().slice(0, 10));

        const [random] = await tiles({ tiles: ['open'], filter: {}, sort: { field: 'random', order: 'asc', seed: 7 } });
        expect(random.count).toBe(13);
        expect(random.rows).toHaveLength(10);
        expect(new Set(random.rows.map(rowId)).size).toBe(10);
    });

    test('a tag that doesn\'t exist is answered missing; each requested id is answered once, in order', async () => {
        await seedFolders();
        const answered = await tiles({ tiles: ['nope', 'open', 'nope', 'shut'], filter: {} });
        expect(answered.map(t => t.id)).toEqual(['nope', 'open', 'shut']);
        expect(answered[0]).toEqual({ id: 'nope', missing: true });
    });

    test('bad requests: tiles not a list of ids, too many tiles, a sort /query refuses', async () => {
        await seedFolders();
        expect(await tilesRequest({ filter: {} })).toEqual({ status: 400, body: { error: true, reason: 'invalid-tiles' } });
        expect((await tilesRequest({ tiles: ['open', ''], filter: {} })).body.reason).toBe('invalid-tiles');
        const tooMany = Array.from({ length: charactersModule.MAX_FOLDER_TILES_PER_REQUEST + 1 }, (_, i) => `t${i}`);
        expect(await tilesRequest({ tiles: tooMany, filter: {} })).toEqual({ status: 400, body: { error: true, reason: 'too-many-tiles', max: charactersModule.MAX_FOLDER_TILES_PER_REQUEST } });
        expect(await tilesRequest({ tiles: ['open'], filter: {}, sort: { field: 'nonsense' } })).toEqual({ status: 400, body: { error: true, reason: 'invalid-sort-field' } });
        for (const want of ['hashes', [], ['rows', 'hashes'], ['total']]) {
            expect((await tilesRequest({ tiles: ['open'], filter: {}, want })).body.reason).toBe('invalid-want');
        }
    });

    test('want: [\'hashes\'] answers each strip as /query\'s hash rows, for the same entities in the same order', async () => {
        await seedFolders();
        for (const filter of [{}, { group: false }, { group: true }]) {
            const withRows = await tiles({ tiles: ['open', 'shut', 'plain'], filter });
            const withHashes = await tiles({ tiles: ['open', 'shut', 'plain'], filter, want: ['hashes'] });
            expect(withHashes.map(({ id, count, hidden }) => ({ id, count, hidden }))).toEqual(withRows.map(({ id, count, hidden }) => ({ id, count, hidden })));
            for (const [index, tile] of withHashes.entries()) {
                expect(tile).not.toHaveProperty('rows');
                expect(tile.hashRows.map(row => row.isGroup ? `group:${row.id}` : row.id)).toEqual(withRows[index].rows.map(rowId));
                for (const row of tile.hashRows) {
                    expect(Object.keys(row).sort()).toEqual(['chat', 'chat_size', 'contentHash', 'create_date', 'data_size', 'date_added', 'date_last_chat', 'favHash', 'id', 'isGroup', 'tagIdsHash']);
                    for (const hash of [row.favHash, row.tagIdsHash, row.contentHash]) expect(Number.isInteger(hash) && hash >= 0).toBe(true);
                }
            }
        }
    });

    describe.each([['tag columns filled', true], ['tag columns not filled yet', false]])('%s', (_, ready) => {
        test('every closed folder hides, however many there are: past one read batch and past SQLite\'s bound-parameter limit', async () => {
            // Ids sort as c00000 … c39999, so the last one is read in the last batch.
            const closed = Array.from({ length: 40000 }, (_, i) => ({ id: `c${String(i).padStart(5, '0')}`, name: `Closed ${i}`, folder_type: 'CLOSED' }));
            expect(await metadataDb.saveTagDefinitions(directories, [...FOLDERS, ...closed])).toBe('ok');
            if (ready) await makeTagColumnsReady();
            expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(ready);
            await seedCharacter('A.png');
            await seedCharacter('First.png');
            await seedCharacter('Last.png');
            await seedGroup('g1', 'Gamma');
            await tag('A.png', ['open']);
            await tag('First.png', ['open', 'c00000']);
            await tag('Last.png', ['open', 'c39999']);
            await tag('g1', ['open', 'c39999']);

            for (const filter of [{}, { group: true }, { group: false }]) {
                const [open] = await tiles({ tiles: ['open'], filter });
                expect(open.hidden).toBe(filter.group === true ? 4 : 3);
                expect(open.rows.map(rowId)).toEqual(filter.group === true ? [] : ['A.png']);
            }
            const [last] = await tiles({ tiles: ['c39999'], filter: {} });
            expect(last.rows.map(rowId)).toEqual(['group:g1', 'Last.png']);
        }, 60000);
    });

    describe('with a search term', () => {
        /** Repeats the request until the search indexes have caught up: two answers in a row agree. */
        async function settledTiles(body) {
            let previous = JSON.stringify(await tiles(body));
            const deadline = Date.now() + 10000;
            for (;;) {
                await new Promise(resolve => setTimeout(resolve, 100));
                const next = await tiles(body);
                if (JSON.stringify(next) === previous || Date.now() > deadline) return next;
                previous = JSON.stringify(next);
            }
        }

        async function seedSearch() {
            expect(await metadataDb.saveTagDefinitions(directories, FOLDERS)).toBe('ok');
            // Names differ in their first letters: a search's name order compares only a short prefix.
            await seedCharacter('Vlad.png', { name: 'Vlad the Vampire', file: true });
            await seedCharacter('Anna.png', { name: 'Anna the Vampire', file: true });
            await seedCharacter('Hid.png', { name: 'Hid the Vampire', file: true });
            await seedCharacter('Human.png', { name: 'Human', file: true });
            await seedGroup('g1', 'Vampire Coven');
            await tag('Vlad.png', ['open']);
            await tag('Anna.png', ['open']);
            await tag('Hid.png', ['open', 'shut']);
            await tag('Human.png', ['open']);
            await tag('g1', ['open']);
        }

        test.each([
            ['a field order', { field: 'name', order: 'asc' }, ids => ids],
            // The three match equally well, so their relevance order isn't checked.
            ['relevance order', { field: 'search' }, ids => [...ids].sort((a, b) => a.localeCompare(b))],
        ])('in %s, a tile counts and shows only the matches', async (_, sort, inCheckedOrder) => {
            if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;
            await seedSearch();
            const [open] = await settledTiles({ tiles: ['open'], filter: { search: 'vampire' }, sort });
            expect(open.count).toBe(3);
            // Human doesn't match, and Hid is in the closed folder.
            expect(open.hidden).toBe(2);
            expect(inCheckedOrder(open.rows.map(rowId))).toEqual(['Anna.png', 'group:g1', 'Vlad.png']);

            const [groupsOnly] = await settledTiles({ tiles: ['open'], filter: { search: 'vampire', group: true }, sort });
            expect(groupsOnly).toMatchObject({ count: 1, hidden: 4 });
            expect(groupsOnly.rows.map(rowId)).toEqual(['group:g1']);
        }, 30000);

        test.each([
            ['a field order', { field: 'name', order: 'asc' }],
            ['relevance order', { field: 'search' }],
        ])('in %s, every closed folder hides, past SQLite\'s bound-parameter limit', async (_, sort) => {
            if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;
            const closed = Array.from({ length: 40000 }, (_, i) => ({ id: `c${String(i).padStart(5, '0')}`, name: `Closed ${i}`, folder_type: 'CLOSED' }));
            expect(await metadataDb.saveTagDefinitions(directories, [...FOLDERS, ...closed])).toBe('ok');
            await seedCharacter('Anna.png', { name: 'Anna the Vampire', file: true });
            await seedCharacter('Last.png', { name: 'Last the Vampire', file: true });
            await seedGroup('g1', 'Vampire Coven');
            await tag('Anna.png', ['open']);
            await tag('Last.png', ['open', 'c39999']);
            await tag('g1', ['open', 'c39999']);
            // The closed folder's own tile shows both: they're indexed.
            const [shut] = await settledTiles({ tiles: ['c39999'], filter: { search: 'vampire' }, sort });
            expect(shut).toMatchObject({ count: 2, hidden: 0 });
            const [open] = await tiles({ tiles: ['open'], filter: { search: 'vampire' }, sort });
            expect(open).toMatchObject({ count: 1, hidden: 2 });
            expect(open.rows.map(rowId)).toEqual(['Anna.png']);
        }, 60000);

        test('in relevance order, the count covers matches past the strip', async () => {
            if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;
            expect(await metadataDb.saveTagDefinitions(directories, FOLDERS)).toBe('ok');
            for (let i = 0; i < 20; i++) {
                const avatar = `V${String(i).padStart(2, '0')}.png`;
                await seedCharacter(avatar, { name: `Vampire ${i}`, file: true });
                await tag(avatar, ['open']);
            }
            const [open] = await settledTiles({ tiles: ['open'], filter: { search: 'vampire' }, sort: { field: 'search' } });
            expect(open.count).toBe(20);
            expect(open.hidden).toBe(0);
            expect(open.rows).toHaveLength(10);
        }, 30000);
    });
});
