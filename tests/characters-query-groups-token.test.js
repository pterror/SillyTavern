import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// /query's token on the search path with groups covers the groups index's whole position: the groups version and
// the tag-rename-log seq it covers. A tag rename moves only the latter for groups.

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {typeof import('../src/endpoints/search-engine.js')} */
let searchEngine;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    const { router } = await import('../src/endpoints/characters.js');
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
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-query-groups-token-test-'));
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
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

async function query(body) {
    const response = await fetch(`${baseUrl}/api/characters/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return response.json();
}

/** Repeats `request` until two answers in a row carry the same token: both indexes have caught up. */
async function settledQuery(request) {
    let previous = await query(request);
    const deadline = Date.now() + 10000;
    for (;;) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const next = await query(request);
        if (next.token === previous.token || Date.now() > deadline) return next;
        previous = next;
    }
}

/** The groups reader /query reads the groups index's position from. */
const groupsReader = () => searchCoordinator.getSearchIndex(`test-user-${path.basename(directories.root)}`, directories, 'groups');

async function seed() {
    const name = 'Vampire';
    const card = JSON.stringify({
        name, spec: 'chara_card_v2', spec_version: '2.0',
        data: {
            name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' },
        },
    });
    const image = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    await fs.promises.writeFile(path.join(directories.characters, 'Vampire.png'), cardParser.write(image, card));
    await metadataDb.upsertCharacterFromWrite(directories, 'Vampire.png', card);
    const group = { id: 'g1', name: 'Vampire Coven', members: [], chats: [], fav: false };
    await metadataDb.writeGroupFileAndRow(directories, group, () => fs.writeFileSync(path.join(directories.groups, 'g1.json'), JSON.stringify(group)));
}

describe.each([
    ['tantivy sorted', { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 10 }],
    ['SQL sorted', { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'search' }, page: 1, pageSize: 10 }],
])('/query on the search path with groups, %s', (_name, request) => {
    test('a groups index position that moved only its tag-rename seq is not answered unchanged', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;
        await seed();
        const first = await settledQuery(request);
        expect(typeof first.token).toBe('string');
        expect(await query({ ...request, ifToken: first.token })).toEqual({ seq: first.seq, token: first.token, unchanged: true });

        const reader = await groupsReader();
        reader.position = { ...reader.position, tagNameSeq: reader.position.tagNameSeq + 1 };
        const moved = await query({ ...request, ifToken: first.token });
        expect(moved.unchanged).toBeUndefined();
        expect(moved.token).not.toBe(first.token);
    }, 30000);

    test('a groups index position without a tag-rename seq is never answered unchanged', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;
        await seed();
        const first = await settledQuery(request);
        const reader = await groupsReader();
        reader.position = { version: reader.position.version };

        expect((await query({ ...request, ifToken: first.token })).unchanged).toBeUndefined();
    }, 30000);
});
