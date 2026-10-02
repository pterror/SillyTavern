import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {import('express').Router} */
let router;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/**
 * Mounts the real characters.js router behind a fake auth middleware, mirroring characters-manifest.test.js's
 * setup - the middleware reads `directories` from this file's outer-scope `let` at request time (not a snapshot
 * taken once in beforeAll), so beforeEach can point every test at a fresh temp directory / fresh SQLite metadata
 * db without needing a new server per test.
 */
beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/characters.js'));
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        // Handle derived from the current test's tempDir (unique per test via mkdtempSync's random suffix), not
        // a fixed string: search index workers are keyed by handle, and each one maintains the index of the
        // `directories` it was spawned with. A real user's handle never remaps to different `directories`.
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

/**
 * A fresh temp user directory tree. Assigning it to `directories` also switches the request's handle, since the
 * fake auth middleware derives the handle from `directories.root`.
 * @returns {import('../src/users.js').UserDirectoryList}
 */
function makeUserDirectories() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-query-test-'));
    const charactersDir = path.join(tempDir, 'characters');
    const chatsDir = path.join(tempDir, 'chats');
    const groupsDir = path.join(tempDir, 'groups');
    const groupChatsDir = path.join(tempDir, 'groupChats');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.mkdirSync(groupChatsDir, { recursive: true });
    return /** @type {import('../src/users.js').UserDirectoryList} */ ({ root: tempDir, characters: charactersDir, chats: chatsDir, groups: groupsDir, groupChats: groupChatsDir });
}

beforeEach(() => {
    directories = makeUserDirectories();
});

afterEach(async () => {
    // Each test's handle has its own search index worker, holding its own connection to this test's db.
    await searchCoordinator.disposeSearchWorkers();
    // Fresh tempDir (and therefore a fresh SQLite cache key - character-metadata-db.js keys its per-user entry
    // map by directories.root) every test, so this just closes whatever this test's calls opened rather than
    // leaking a growing set of open db handles across the whole suite.
    metadataDb.disposeMetadataStores();
});

async function postJson(urlPath, body) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return response;
}

/**
 * Seeds one row directly through the phase-1 write-path hook (the same one characters.js's real write routes
 * call), rather than writing a real PNG - /query never touches the filesystem, so this is the right layer to
 * seed at for these tests.
 * @param {string} avatar
 * @param {object} overrides Shallow-merged onto a minimal valid Spec V2 card
 */
async function seedCharacter(avatar, overrides = {}) {
    const card = {
        name: avatar.replace(/\.png$/, ''),
        fav: false,
        data: {
            name: avatar.replace(/\.png$/, ''),
            tags: [],
            creator: '',
            character_version: '',
            creator_notes: '',
            extensions: { fav: false, world: '' },
        },
        ...overrides,
    };
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify(card));
}

/**
 * Like seedCharacter(), but the card has the shape the app stores in card_json (see /create): a spec'd V2 card
 * whose top-level fields mirror `data.*`, with no fav.
 * @param {string} avatar
 * @param {object} data Merged onto the card's `data`
 */
async function seedStoredCharacter(avatar, data = {}) {
    const name = avatar.replace(/\.png$/, '');
    const cardData = {
        name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
        tags: [], creator: '', character_version: '', creator_notes: '',
        extensions: { world: '' },
        ...data,
    };
    const card = {
        name: cardData.name,
        description: cardData.description,
        personality: cardData.personality,
        scenario: cardData.scenario,
        first_mes: cardData.first_mes,
        mes_example: cardData.mes_example,
        tags: cardData.tags,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: cardData,
    };
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify(card));
}

/**
 * Like seedCharacter(), but also writes a real (parseable) PNG to `directories.characters` - needed for the
 * `filter.search` tests below, since search (characters-search-index.js) reads full character data straight off
 * disk to build its index, unlike plain `/query` which never touches the filesystem. Mirrors
 * character-metadata-db.test.js's writeCardFile().
 * @param {string} avatar
 * @param {object} overrides Shallow-merged onto a minimal valid Spec V2 card
 */
async function seedCharacterWithFile(avatar, overrides = {}) {
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const name = avatar.replace(/\.png$/, '');
    const card = {
        name,
        fav: false,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '',
            extensions: { fav: false, world: '' },
        },
        ...overrides,
    };
    const buffer = cardParser.write(baseImage, JSON.stringify(card));
    await fs.promises.writeFile(path.join(directories.characters, avatar), buffer);
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify(card));
}

/**
 * @param {string} characterId
 * @param {string[]} tagIds
 */
function assignTags(characterId, tagIds) {
    // resyncTags() mirrors tags.json's tag_map into character_tags - write tags.json directly (the real write
    // path phase 3 will eventually replace) and force a resync, same as character-metadata-db.test.js does.
    const tagsPath = path.join(directories.root, 'tags.json');
    const existing = fs.existsSync(tagsPath) ? JSON.parse(fs.readFileSync(tagsPath, 'utf-8')) : { tags: [], tag_map: {} };
    existing.tag_map[characterId] = tagIds;
    fs.writeFileSync(tagsPath, JSON.stringify(existing));
}

/**
 * Seeds one group directly through the real write path (the group JSON file plus the phase-3 write-path hook,
 * the same two things groups.js's /create route does) - mirrors seedCharacter()'s "seed at the layer /query
 * actually reads from" approach.
 * @param {string} id
 * @param {object} overrides Shallow-merged onto a minimal group object
 */
async function seedGroup(id, overrides = {}) {
    const group = { id, name: id, members: [], chats: [], fav: false, ...overrides };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, group.name, { fav: group.fav });
}

describe('POST /api/characters/query - filter.includeGroups (extends the design doc to groups)', () => {
    test('includeGroups: false/absent is byte-for-byte the existing characters-only response shape', async () => {
        await seedCharacter('Alice.png');
        await seedGroup('g1');

        const response = await postJson('/api/characters/query', { page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.total).toBe(1); // the group is not counted
        expect(body.rows).toEqual([expect.objectContaining({ avatar: 'Alice.png' })]);
        expect(body.rows[0].type).toBeUndefined(); // still a bare Character, not {type, item}
    });

    test('merges characters and groups into one {type, item}[] page, sorted by name together', async () => {
        await seedCharacter('Zebra.png', { name: 'Zebra', data: { name: 'Zebra', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedGroup('g1', { name: 'Middle Group' });
        await seedCharacter('Apple.png', { name: 'Apple', data: { name: 'Apple', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.total).toBe(3);
        expect(body.rows.map(r => [r.type, r.item.name])).toEqual([
            ['character', 'Apple'],
            ['group', 'Middle Group'],
            ['character', 'Zebra'],
        ]);
        // A group's hydrated item carries the metadata-row-sourced fields, not a stale/absent value off the raw file.
        expect(body.rows[1].item.id).toBe('g1');
        expect(typeof body.rows[1].item.date_added).toBe('number');
    });

    test('paginates the merged sequence as one combined page, not per-type pages', async () => {
        for (let i = 0; i < 3; i++) {
            await seedCharacter(`Char${i}.png`, { name: `Char${i}`, data: { name: `Char${i}`, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        }
        for (let i = 0; i < 3; i++) {
            await seedGroup(`Group${i}`, { name: `Group${i}` });
        }

        const page1 = await (await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 2 })).json();
        const page2 = await (await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' }, page: 2, pageSize: 2 })).json();
        const page3 = await (await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' }, page: 3, pageSize: 2 })).json();

        expect(page1.total).toBe(6);
        const allNames = [...page1.rows, ...page2.rows, ...page3.rows].map(r => r.item.name);
        expect(allNames).toEqual(['Char0', 'Char1', 'Char2', 'Group0', 'Group1', 'Group2']);
    });

    test('each sort field orders characters and groups together: date_added', async () => {
        await seedCharacter('Old.png', { name: 'Old', data: { name: 'Old', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedGroup('g-mid');
        await new Promise(resolve => setTimeout(resolve, 5));
        await seedCharacter('New.png', { name: 'New', data: { name: 'New', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'date_added', order: 'asc' }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.rows.length).toBe(3);
        // Old.png and g-mid seeded before New.png/-created-later - New must sort last.
        expect(body.rows[body.rows.length - 1].item.avatar ?? body.rows[body.rows.length - 1].item.id).toBe('New.png');
    });

    test('each sort field orders characters and groups together: create_date (2026-08 regression - a group interleaves by its real date_added, not parked at one end by a TEXT/INTEGER type mismatch)', async () => {
        await seedCharacter('Old.png', { name: 'Old', create_date: '2020-01-01T00:00:00.000Z', data: { name: 'Old', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedGroup('g-mid'); // no create_date of its own - its date_added (seeded "now") stands in for it
        await seedCharacter('New.png', { name: 'New', create_date: '2030-01-01T00:00:00.000Z', data: { name: 'New', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'create_date', order: 'asc' }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.rows.length).toBe(3);
        // Old (2020) first, New (2030) last - the group's own date_added (seeded at test run time, i.e. 2026)
        // genuinely falls in between the two, so it must land in the middle, not clustered at either end.
        expect(body.rows.map(r => r.type)).toEqual(['character', 'group', 'character']);
        expect(body.rows[0].item.avatar).toBe('Old.png');
        expect(body.rows[2].item.avatar).toBe('New.png');
    });

    test('each sort field orders characters and groups together: date_last_chat', async () => {
        await seedCharacter('NoChat.png');
        await seedGroup('g1', { chats: ['c1'] });
        await metadataDb.applyGroupChatStats(directories, 'g1', { sizeChange: 1, addedCreatedAt: Date.now(), readLastCreatedAt: null });

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'date_last_chat', order: 'desc' }, page: 1, pageSize: 10 });
        const body = await response.json();
        // The group (which has a real date_last_chat) sorts before the character (date_last_chat 0) descending.
        expect(body.rows[0].type).toBe('group');
        expect(body.rows[1].type).toBe('character');
    });

    test('each sort field orders characters and groups together: chat_size', async () => {
        await seedCharacter('NoChat.png');
        await seedGroup('g1', { chats: ['c1'] });
        await metadataDb.applyGroupChatStats(directories, 'g1', { sizeChange: 500, addedCreatedAt: Date.now(), readLastCreatedAt: null });

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'chat_size', order: 'desc' }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.rows[0].type).toBe('group');
        expect(body.rows[0].item.chat_size).toBe(500);
    });

    test('each sort field orders characters and groups together: fav', async () => {
        await seedCharacter('NotFav.png');
        await seedGroup('FavGroup', { fav: true });

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'fav', order: 'desc' }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.rows[0]).toEqual(expect.objectContaining({ type: 'group' }));
        expect(body.rows[0].item.fav).toBe(true);
    });

    test('each sort field orders characters and groups together: random, with a seed', async () => {
        for (let i = 0; i < 4; i++) {
            await seedCharacter(`Char${i}.png`, { name: `Char${i}`, data: { name: `Char${i}`, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        }
        for (let i = 0; i < 4; i++) {
            await seedGroup(`Group${i}`, { name: `Group${i}` });
        }

        const first = await (await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'random', seed: 99 }, page: 1, pageSize: 8 })).json();
        const second = await (await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'random', seed: 99 }, page: 1, pageSize: 8 })).json();

        expect(first.total).toBe(8);
        expect(first.rows.map(r => r.item.id ?? r.item.avatar)).toEqual(second.rows.map(r => r.item.id ?? r.item.avatar));
        // Not simply "all characters then all groups" - proves the hash genuinely interleaves the two types.
        const typeSequence = first.rows.map(r => r.type);
        expect(new Set(typeSequence)).toEqual(new Set(['character', 'group']));
    });

    test('filter.tags.include ("open a folder") matches characters and groups carrying the tag, together', async () => {
        await seedCharacter('Tagged.png');
        await seedCharacter('Untagged.png', { name: 'Untagged', data: { name: 'Untagged', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedGroup('TaggedGroup');
        await seedGroup('UntaggedGroup');
        assignTags('Tagged.png', ['folder-1']);
        await metadataDb.resyncTags(directories);
        // Unlike characters, group tag assignments have no tags.json mirror to resync from (resyncTags() is
        // characters-only - see its own doc comment) - group_tags is assigned directly via the phase-3 write
        // path, same as groups.js's real /api/tags/assign route would do.
        await metadataDb.assignEntityTag(directories, 'TaggedGroup', 'folder-1');

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true, tags: { include: ['folder-1'] } }, sort: { field: 'name' }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.total).toBe(2);
        expect(body.rows.map(r => `${r.type}:${r.item.name}`).sort()).toEqual(['character:Tagged', 'group:TaggedGroup']);
    });

    test('filter.fav narrows both characters and groups', async () => {
        await seedCharacter('FavChar.png', { fav: true, data: { name: 'FavChar', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: true, world: '' } } });
        await seedCharacter('PlainChar.png', { name: 'PlainChar', data: { name: 'PlainChar', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedGroup('FavGroup', { fav: true });
        await seedGroup('PlainGroup', { fav: false });

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true, fav: true }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.total).toBe(2);
        expect(body.rows.map(r => r.item.name).sort()).toEqual(['FavChar', 'FavGroup']);
    });

    test('filter.search includes groups in the merged, relevance-ordered result when both a character and a group match (groups have their own full-text index, groups-search-index.js)', async () => {
        await seedCharacterWithFile('Vampire.png', { name: 'Vampire Lord', data: { name: 'Vampire Lord', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedGroup('VampireGroup', { name: 'Vampire Group' });
        await seedCharacterWithFile('Unrelated.png', { name: 'Someone Else', data: { name: 'Someone Else', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedGroup('OtherGroup', { name: 'Other Group' });

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'search' }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.total).toBe(2);
        expect(body.rows).toEqual(expect.arrayContaining([
            { type: 'character', item: expect.objectContaining({ avatar: 'Vampire.png' }) },
            { type: 'group', item: expect.objectContaining({ id: 'VampireGroup' }) },
        ]));
        expect(body.rows).toHaveLength(2);
    });

    test('filter.search + includeGroups still excludes a group that does not match the term', async () => {
        await seedCharacterWithFile('Vampire.png', { name: 'Vampire Lord', data: { name: 'Vampire Lord', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedGroup('OtherGroup', { name: 'Other Group' });

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'search' }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.rows).toEqual([{ type: 'character', item: expect.objectContaining({ avatar: 'Vampire.png' }) }]);
        expect(body.total).toBe(1);
    });

    test('filter.search + includeGroups composes with an ordinary (non-search) sort field across both types', async () => {
        await seedCharacterWithFile('VampireB.png', { name: 'Vampire Baron', data: { name: 'Vampire Baron', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedGroup('VampireA', { name: 'Vampire Alpha' });

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.total).toBe(2);
        expect(body.rows).toHaveLength(2);
    });

    test.each(['create_date', 'date_added', 'date_last_chat'])('filter.search + includeGroups + %s ascending returns 200 with a group whose file times are fractional ms', async (field) => {
        await seedCharacterWithFile('VampireB.png', { name: 'Vampire Baron', data: { name: 'Vampire Baron', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedGroup('VampireA', { name: 'Vampire Alpha', chats: ['c1'] });
        fs.writeFileSync(path.join(directories.groupChats, 'c1.jsonl'), 'x');
        const fractionalMs = 1775384635918.478;
        fs.utimesSync(path.join(directories.groupChats, 'c1.jsonl'), fractionalMs / 1000, fractionalMs / 1000);

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'vampire' }, sort: { field, order: 'asc' }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.total).toBe(2);
        expect(body.rows).toHaveLength(2);
    });

    test('filter.search + includeGroups + create_date puts a group between characters just older and just newer than it, ascending and descending reversed', async () => {
        await seedGroup('VampireGroup', { name: 'Vampire Group' });
        const groupDate = fs.statSync(path.join(directories.groups, 'VampireGroup.json')).birthtimeMs;
        // More than 2048 ms either side: tantivy reports an ascending character's order rounded to a multiple of
        // 2048 at these magnitudes, so closer dates tie with the group.
        const cardFor = (name, createDate) => ({ name, create_date: new Date(createDate).toISOString(), data: { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedCharacterWithFile('VampireOlder.png', cardFor('Vampire Older', groupDate - 5000));
        await seedCharacterWithFile('VampireNewer.png', cardFor('Vampire Newer', groupDate + 5000));

        const idsFor = async (order) => {
            const response = await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'create_date', order }, page: 1, pageSize: 10 });
            expect(response.status).toBe(200);
            return (await response.json()).rows.map(r => r.type === 'group' ? r.item.id : r.item.avatar);
        };
        expect(await idsFor('asc')).toEqual(['VampireOlder.png', 'VampireGroup', 'VampireNewer.png']);
        expect(await idsFor('desc')).toEqual(['VampireNewer.png', 'VampireGroup', 'VampireOlder.png']);
    });

    test('a deleted group is not resolvable via getGroupsByIds and is simply dropped from the page rather than shipping a null item', async () => {
        await seedGroup('g1');
        // Delete the file but leave the metadata row behind (simulating drift) - the route must not crash or
        // emit a null item.
        fs.unlinkSync(path.join(directories.groups, 'g1.json'));

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.rows).toEqual([]);
    });
});

describe('POST /api/characters/query - random sort is per user', () => {
    /**
     * Seeds two characters (with card files, so search can index them) and one group into the current user.
     * Every user gets the same number of each, so both users' change seq and groups version line up.
     * @param {string} prefix
     */
    async function seedUser(prefix) {
        for (const n of [1, 2]) {
            const name = `${prefix} Vampire ${n}`;
            await seedCharacterWithFile(`${prefix}${n}.png`, { name, data: { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        }
        await seedGroup(`${prefix}Group`, { name: `${prefix} Group` });
    }

    /** @param {any} body */
    const idsOf = body => body.rows.map(r => r.item.id ?? r.item.avatar).sort();

    test.each([
        ['without a search', {}],
        ['with a search', { search: 'vampire' }],
    ])('two users with the same seed each get only their own ids (%s)', async (_label, extraFilter) => {
        const request = { filter: { includeGroups: true, ...extraFilter }, sort: { field: 'random', seed: 7 }, page: 1, pageSize: 10 };
        const expectA = extraFilter.search ? ['Alpha1.png', 'Alpha2.png'] : ['Alpha1.png', 'Alpha2.png', 'AlphaGroup'];
        const expectB = extraFilter.search ? ['Beta1.png', 'Beta2.png'] : ['Beta1.png', 'Beta2.png', 'BetaGroup'];

        await seedUser('Alpha');
        const a = await postJson('/api/characters/query', request);
        expect(a.status).toBe(200);
        expect(idsOf(await a.json())).toEqual(expectA);

        const userA = directories;
        directories = makeUserDirectories();
        await seedUser('Beta');
        const b = await postJson('/api/characters/query', request);
        expect(b.status).toBe(200);
        expect(idsOf(await b.json())).toEqual(expectB);

        directories = userA;
        const again = await postJson('/api/characters/query', request);
        expect(again.status).toBe(200);
        expect(idsOf(await again.json())).toEqual(expectA);
    });
});

describe('POST /api/characters/query', () => {
    test('with no characters, returns empty rows and a zero total', async () => {
        const response = await postJson('/api/characters/query', { page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.rows).toEqual([]);
        expect(body.total).toBe(0);
        expect(typeof body.seq).toBe('number');
    });

    test('never reads the filesystem - characters not yet reconciled/indexed are simply absent, not read live', async () => {
        // A PNG dropped on disk with no metadata-db row at all (no write-path hook, no reconcile pass run).
        fs.writeFileSync(path.join(directories.characters, 'Ghost.png'), 'not a real card');
        const response = await postJson('/api/characters/query', { page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.rows).toEqual([]);
        expect(body.total).toBe(0);
    });

    test('returns shallow rows for seeded characters, sorted by name ascending', async () => {
        await seedCharacter('Bob.png');
        await seedCharacter('Alice.png');
        await seedCharacter('carol.png', { name: 'carol' });

        const response = await postJson('/api/characters/query', { sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.total).toBe(3);
        expect(body.rows.map(r => r.name)).toEqual(['Alice', 'Bob', 'carol']);
        expect(body.rows[0].shallow).toBe(true);
    });

    test('sort order desc reverses the page', async () => {
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');

        const response = await postJson('/api/characters/query', { sort: { field: 'name', order: 'desc' }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.rows.map(r => r.name)).toEqual(['Bob', 'Alice']);
    });

    test('paginates correctly across two pages with a stable id tie-break', async () => {
        for (let i = 0; i < 5; i++) {
            await seedCharacter(`Char${i}.png`, { name: `Char${i}`, data: { name: `Char${i}`, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        }

        const page1 = await (await postJson('/api/characters/query', { sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 2 })).json();
        const page2 = await (await postJson('/api/characters/query', { sort: { field: 'name', order: 'asc' }, page: 2, pageSize: 2 })).json();
        const page3 = await (await postJson('/api/characters/query', { sort: { field: 'name', order: 'asc' }, page: 3, pageSize: 2 })).json();

        expect(page1.total).toBe(5);
        const allNames = [...page1.rows, ...page2.rows, ...page3.rows].map(r => r.name);
        expect(allNames).toEqual(['Char0', 'Char1', 'Char2', 'Char3', 'Char4']);
    });

    test('total is never capped by pageSize - a broad match over a big library still reports the real count', async () => {
        for (let i = 0; i < 12; i++) {
            await seedCharacter(`Char${i}.png`, { name: `Char${i}`, data: { name: `Char${i}`, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        }
        const response = await postJson('/api/characters/query', { page: 1, pageSize: 3 });
        const body = await response.json();
        expect(body.rows.length).toBe(3);
        expect(body.total).toBe(12);
    });

    test('filter.fav narrows to favorites only', async () => {
        await seedCharacter('Fav.png', { fav: true, data: { name: 'Fav', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: true, world: '' } } });
        await seedCharacter('NotFav.png', { fav: false, data: { name: 'NotFav', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        const response = await postJson('/api/characters/query', { filter: { fav: true }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.total).toBe(1);
        expect(body.rows[0].name).toBe('Fav');
    });

    test('filter.world narrows to a lorebook', async () => {
        await seedStoredCharacter('A.png', { extensions: { world: 'Wonderland' } });
        await seedStoredCharacter('B.png', { extensions: { world: 'Oz' } });

        const response = await postJson('/api/characters/query', { filter: { world: 'Wonderland' }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.total).toBe(1);
        expect(body.rows[0].name).toBe('A');
    });

    test('filter.tags include with mode "and" requires every tag', async () => {
        await seedCharacter('Both.png');
        await seedCharacter('OneOnly.png', { name: 'OneOnly', data: { name: 'OneOnly', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        assignTags('Both.png', ['tag-a', 'tag-b']);
        assignTags('OneOnly.png', ['tag-a']);
        await metadataDb.resyncTags(directories);

        const response = await postJson('/api/characters/query', { filter: { tags: { include: ['tag-a', 'tag-b'], mode: 'and' } }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.total).toBe(1);
        expect(body.rows[0].name).toBe('Both');
    });

    test('filter.tags include with mode "or" requires any tag', async () => {
        await seedCharacter('HasA.png', { name: 'HasA', data: { name: 'HasA', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedCharacter('HasB.png', { name: 'HasB', data: { name: 'HasB', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedCharacter('HasNeither.png', { name: 'HasNeither', data: { name: 'HasNeither', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        assignTags('HasA.png', ['tag-a']);
        assignTags('HasB.png', ['tag-b']);
        await metadataDb.resyncTags(directories);

        const response = await postJson('/api/characters/query', { filter: { tags: { include: ['tag-a', 'tag-b'], mode: 'or' } }, sort: { field: 'name' }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.total).toBe(2);
        expect(body.rows.map(r => r.name).sort()).toEqual(['HasA', 'HasB']);
    });

    test('filter.tags exclude removes matching characters', async () => {
        await seedCharacter('Tagged.png');
        await seedCharacter('Untagged.png', { name: 'Untagged', data: { name: 'Untagged', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        assignTags('Tagged.png', ['tag-x']);
        await metadataDb.resyncTags(directories);

        const response = await postJson('/api/characters/query', { filter: { tags: { exclude: ['tag-x'] } }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.total).toBe(1);
        expect(body.rows[0].name).toBe('Untagged');
    });

    test('filter.ids resolves a specific batch by id', async () => {
        await seedCharacter('A.png');
        await seedCharacter('B.png', { name: 'B', data: { name: 'B', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedCharacter('C.png', { name: 'C', data: { name: 'C', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        const response = await postJson('/api/characters/query', { filter: { ids: ['A.png', 'C.png'] }, sort: { field: 'name' }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.total).toBe(2);
        expect(body.rows.map(r => r.avatar).sort()).toEqual(['A.png', 'C.png']);
    });

    test('filter.ids: [] (explicitly empty) resolves to nothing, not "no filter"', async () => {
        await seedCharacter('A.png');
        const response = await postJson('/api/characters/query', { filter: { ids: [] }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.total).toBe(0);
        expect(body.rows).toEqual([]);
    });

    test('filter.excludeIds removes group members from the candidate set', async () => {
        await seedCharacter('Member.png');
        await seedCharacter('NonMember.png', { name: 'NonMember', data: { name: 'NonMember', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        const response = await postJson('/api/characters/query', { filter: { excludeIds: ['Member.png'] }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.total).toBe(1);
        expect(body.rows[0].name).toBe('NonMember');
    });

    test('want: ["total"] alone omits rows from the response', async () => {
        await seedCharacter('A.png');
        const response = await postJson('/api/characters/query', { want: ['total'], page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.total).toBe(1);
        expect(body.rows).toBeUndefined();
    });

    test('want: ["rows"] alone omits total from the response', async () => {
        await seedCharacter('A.png');
        const response = await postJson('/api/characters/query', { want: ['rows'], page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.rows.length).toBe(1);
        expect(body.total).toBeUndefined();
    });

    test('sort.field "random" without a seed 400s instead of silently falling back to name order', async () => {
        const response = await postJson('/api/characters/query', { sort: { field: 'random' } });
        expect(response.status).toBe(400);
        expect((await response.json()).reason).toBe('random-seed-required');
    });

    test('sort.field "search" without filter.search 400s', async () => {
        const response = await postJson('/api/characters/query', { sort: { field: 'search' } });
        expect(response.status).toBe(400);
        expect((await response.json()).reason).toBe('search-sort-requires-search');
    });

    test('rejects an unknown sort field with 400', async () => {
        const response = await postJson('/api/characters/query', { sort: { field: 'bogus' } });
        expect(response.status).toBe(400);
    });

    test('rejects want: ["facets"] with 400 rather than silently ignoring it', async () => {
        const response = await postJson('/api/characters/query', { want: ['facets'] });
        expect(response.status).toBe(400);
    });

    test('a rename does not change the row\'s date_added, and seq advances', async () => {
        await seedCharacter('Old.png', {});
        const before = await (await postJson('/api/characters/query', { filter: { ids: ['Old.png'] } })).json();

        await metadataDb.upsertCharacterFromWrite(directories, 'New.png', JSON.stringify({ name: 'New', data: { name: 'New', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } }));
        await metadataDb.renameCharacterRow(directories, 'Old.png', 'New.png');

        const after = await (await postJson('/api/characters/query', { filter: { ids: ['New.png'] } })).json();
        expect(after.rows[0].date_added).toBe(before.rows[0].date_added);
        expect(after.seq).toBeGreaterThan(before.seq);
    });
});

/**
 * The token of a hash-mode (`want: ['hashes']`) response: its trailer, after the last row.
 * @param {ArrayBuffer} buffer
 * @returns {string | null}
 */
function hashResponseToken(buffer) {
    const view = new DataView(buffer);
    let offset = 1 + 1 + 8 + 8;
    const rowCount = view.getUint16(offset, true); offset += 2;
    for (let i = 0; i < rowCount; i++) {
        offset += 1;
        offset += 2 + view.getUint16(offset, true);
        offset += 4 + 4 + 4 + 8 + 8 + 8 + 8 + 8;
        offset += 2 + view.getUint16(offset, true);
    }
    const tokenLen = view.getUint16(offset, true); offset += 2;
    expect(offset + tokenLen).toBe(buffer.byteLength);
    return tokenLen > 0 ? new TextDecoder().decode(new Uint8Array(buffer, offset, tokenLen)) : null;
}

describe('POST /api/characters/query - the freshness token (token / ifToken)', () => {
    /** @param {string} name */
    const cardFor = (name) => ({ name, data: { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

    test('without search: the same token answers unchanged until a write, and a write gets a new token and the new rows', async () => {
        await seedCharacter('Alice.png');
        const request = { page: 1, pageSize: 10 };

        const first = await (await postJson('/api/characters/query', request)).json();
        expect(typeof first.token).toBe('string');
        expect(typeof first.seq).toBe('number');

        const again = await (await postJson('/api/characters/query', { ...request, ifToken: first.token })).json();
        expect(again).toEqual({ seq: first.seq, token: first.token, unchanged: true });

        await seedCharacter('Bob.png');
        const afterWrite = await (await postJson('/api/characters/query', { ...request, ifToken: first.token })).json();
        expect(afterWrite.unchanged).toBeUndefined();
        expect(afterWrite.token).not.toBe(first.token);
        expect(afterWrite.rows.map(r => r.avatar).sort()).toEqual(['Alice.png', 'Bob.png']);
    });

    test('a search that lands between a write and the index catching up is not answered unchanged once the index has caught up', async () => {
        await seedCharacterWithFile('Vampire0.png', cardFor('Vampire 0'));
        const request = { filter: { search: 'vampire' }, sort: { field: 'search' }, page: 1, pageSize: 50 };
        // Builds the index.
        await postJson('/api/characters/query', request);

        // The index catches up about once a second, so a search right after a write usually doesn't have it yet.
        let behind = null;
        let avatar = null;
        for (let i = 1; i <= 20 && !behind; i++) {
            avatar = `Vampire${i}.png`;
            await seedCharacterWithFile(avatar, cardFor(`Vampire ${i}`));
            const body = await (await postJson('/api/characters/query', request)).json();
            if (!body.rows.some(r => r.avatar === avatar)) behind = body;
        }
        expect(behind).not.toBeNull();

        let caughtUp;
        const deadline = Date.now() + 5000;
        do {
            await new Promise(resolve => setTimeout(resolve, 50));
            caughtUp = await (await postJson('/api/characters/query', request)).json();
        } while (!caughtUp.rows.some(r => r.avatar === avatar) && Date.now() < deadline);
        expect(caughtUp.rows.map(r => r.avatar)).toContain(avatar);
        // The db's seq didn't move while the index caught up; that alone used to be the whole check.
        expect(caughtUp.seq).toBe(behind.seq);

        // ifSeq, the old check, isn't a freshness check any more: it would call this unchanged.
        const withSeq = await (await postJson('/api/characters/query', { ...request, ifSeq: behind.seq })).json();
        expect(withSeq.unchanged).toBeUndefined();
        expect(withSeq.rows.map(r => r.avatar)).toContain(avatar);

        expect(typeof behind.token).toBe('string');

        const withToken = await (await postJson('/api/characters/query', { ...request, ifToken: behind.token })).json();
        expect(withToken.unchanged).toBeUndefined();
        expect(withToken.rows.map(r => r.avatar)).toContain(avatar);
        expect(withToken.token).toBe(caughtUp.token);
        expect(withToken.token).not.toBe(behind.token);


        const current = await (await postJson('/api/characters/query', { ...request, ifToken: caughtUp.token })).json();
        expect(current).toEqual({ seq: caughtUp.seq, token: caughtUp.token, unchanged: true });
    }, 30000);

    test('a retry that re-indexes a card which failed to index is not answered unchanged, though neither the db seq nor the index cursors moved', async () => {
        const Database = (await import('better-sqlite3')).default;
        const dbPath = path.join(directories.root, 'character-metadata.sqlite');
        /** @param {string} json @param {boolean} change */
        const setCardJson = (json, change) => {
            const db = new Database(dbPath);
            try {
                db.prepare('UPDATE characters SET card_json = ? WHERE id = ?').run(json, 'Vampire.png');
                if (change) db.prepare('INSERT INTO changes (id, op, fields) VALUES (?, \'upsert\', NULL)').run('Vampire.png');
            } finally {
                db.close();
            }
        };
        const fangs = { filter: { search: 'fangs' }, sort: { field: 'search' }, page: 1, pageSize: 10 };
        const garlic = { ...fangs, filter: { search: 'garlic' } };
        const card = cardFor('Vampire');
        await seedCharacterWithFile('Vampire.png', { ...card, data: { ...card.data, description: 'fangs' } });
        expect((await settledQuery(fangs)).rows.map(r => r.avatar)).toEqual(['Vampire.png']);

        // The index can't process this, so it keeps the card's old doc and marks it for retry.
        setCardJson('not json', true);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        let failed;
        try {
            const marked = () => {
                const db = new Database(dbPath, { readonly: true });
                try {
                    return db.prepare('SELECT COUNT(*) AS n FROM character_index_retries').get().n > 0;
                } catch {
                    return false;
                } finally {
                    db.close();
                }
            };
            const markDeadline = Date.now() + 10000;
            while (!marked() && Date.now() < markDeadline) await new Promise(resolve => setTimeout(resolve, 50));
            expect(marked()).toBe(true);
            failed = await settledQuery(fangs);
            expect(failed.rows.map(r => r.avatar)).toEqual(['Vampire.png']);

            // Mended with no change row: only the retry picks it up.
            setCardJson(JSON.stringify({ ...card, spec: 'chara_card_v2', spec_version: '2.0', data: { ...card.data, description: 'garlic' } }), false);
            let mended;
            const deadline = Date.now() + 10000;
            do {
                await new Promise(resolve => setTimeout(resolve, 100));
                mended = await (await postJson('/api/characters/query', garlic)).json();
            } while (mended.rows.length === 0 && Date.now() < deadline);
            expect(mended.rows.map(r => r.avatar)).toEqual(['Vampire.png']);
            expect(mended.seq).toBe(failed.seq);
        } finally {
            errorSpy.mockRestore();
        }

        const stale = await (await postJson('/api/characters/query', { ...fangs, ifToken: failed.token })).json();
        expect(stale.unchanged).toBeUndefined();
        expect(stale.rows).toEqual([]);
    }, 30000);

    /**
     * Repeats `request` until two answers in a row have the same token, so the indexes have settled.
     * @param {object} request
     */
    async function settledQuery(request) {
        let previous = await (await postJson('/api/characters/query', request)).json();
        const deadline = Date.now() + 10000;
        for (;;) {
            await new Promise(resolve => setTimeout(resolve, 50));
            const next = await (await postJson('/api/characters/query', request)).json();
            if (next.token === previous.token || Date.now() > deadline) return next;
            previous = next;
        }
    }

    const groupRequests = {
        'the SQL path': { filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 10 },
        'the search path, tantivy sorted': { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 10 },
        'the search path, SQL sorted': { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'search' }, page: 1, pageSize: 10 },
    };
    const typedIds = (body) => body.rows.map(r => `${r.type}:${r.type === 'group' ? r.item.id : r.item.avatar}`).sort();

    test.each(Object.keys(groupRequests))('with includeGroups on %s, a repeat answers unchanged when nothing moved, and a group write that moves only the groups log is not', async (path) => {
        const request = groupRequests[path];
        await seedCharacterWithFile('Vampire.png', cardFor('Vampire Lord'));
        await seedGroup('g1', { name: 'Vampire Coven' });

        const first = await settledQuery(request);
        expect(typeof first.token).toBe('string');
        expect(typedIds(first)).toEqual(['character:Vampire.png', 'group:g1']);
        const again = await (await postJson('/api/characters/query', { ...request, ifToken: first.token })).json();
        expect(again).toEqual({ seq: first.seq, token: first.token, unchanged: true });

        // A group tag write: it moves the groups log but not MAX(changes.seq), and the groups index doesn't rebuild on it.
        const versionBefore = await metadataDb.getGroupsVersion(directories);
        await metadataDb.assignEntityTag(directories, 'g1', 'folder-1');
        expect(await metadataDb.getGroupsVersion(directories)).toBeGreaterThan(versionBefore);
        const afterWrite = await (await postJson('/api/characters/query', { ...request, ifToken: first.token })).json();
        expect(afterWrite.unchanged).toBeUndefined();
        expect(afterWrite.seq).toBe(first.seq);
        expect(afterWrite.token).not.toBe(first.token);
        expect(typedIds(afterWrite)).toEqual(['character:Vampire.png', 'group:g1']);
    }, 30000);

    test.each(['the search path, tantivy sorted', 'the search path, SQL sorted'])('with includeGroups on %s, a search that lands between a group write and the groups index catching up is not answered unchanged once it has caught up', async (path) => {
        const request = groupRequests[path];
        await seedCharacterWithFile('Vampire.png', cardFor('Vampire Lord'));
        await seedGroup('g0', { name: 'Vampire Coven 0' });
        await settledQuery(request);

        // The groups index catches up about once a second, so a search right after a write usually doesn't have it yet.
        let behind = null;
        let groupId = null;
        for (let i = 1; i <= 20 && !behind; i++) {
            groupId = `g${i}`;
            // As the groups endpoints write a group, so the log row names its file.
            const group = { id: groupId, name: `Vampire Coven ${i}`, members: [], chats: [], fav: false };
            await metadataDb.writeGroupFileAndRow(directories, group, () => fs.writeFileSync(`${directories.groups}/${groupId}.json`, JSON.stringify(group)));
            const body = await (await postJson('/api/characters/query', request)).json();
            if (!body.rows.some(r => r.type === 'group' && r.item.id === groupId)) behind = body;
        }
        expect(behind).not.toBeNull();
        expect(typeof behind.token).toBe('string');
        const logVersion = await metadataDb.getGroupsVersion(directories);

        let caughtUp;
        const deadline = Date.now() + 10000;
        do {
            await new Promise(resolve => setTimeout(resolve, 50));
            caughtUp = await (await postJson('/api/characters/query', request)).json();
        } while (!caughtUp.rows.some(r => r.type === 'group' && r.item.id === groupId) && Date.now() < deadline);
        expect(caughtUp.rows.map(r => r.type === 'group' ? r.item.id : r.item.avatar)).toContain(groupId);
        // Neither log moved while the groups index caught up: only the version it was built from did.
        expect(await metadataDb.getGroupsVersion(directories)).toBe(logVersion);
        expect(caughtUp.seq).toBe(behind.seq);

        const withToken = await (await postJson('/api/characters/query', { ...request, ifToken: behind.token })).json();
        expect(withToken.unchanged).toBeUndefined();
        expect(withToken.rows.map(r => r.type === 'group' ? r.item.id : r.item.avatar)).toContain(groupId);
        expect(withToken.token).not.toBe(behind.token);
    }, 30000);

    test('with includeGroups, a groups version that can\'t be read gives no token and is never answered unchanged; without groups the token stays', async () => {
        await seedCharacter('Alice.png');
        await seedGroup('g1');
        const request = groupRequests['the SQL path'];
        const before = await (await postJson('/api/characters/query', request)).json();
        expect(typeof before.token).toBe('string');

        const Database = (await import('better-sqlite3')).default;
        const raw = new Database(path.join(directories.root, 'character-metadata.sqlite'));
        raw.exec('DROP TABLE group_changes');
        raw.close();

        const withGroups = await (await postJson('/api/characters/query', request)).json();
        expect(withGroups.token).toBeNull();
        expect(withGroups.rows.length).toBe(2);
        const again = await (await postJson('/api/characters/query', { ...request, ifToken: before.token })).json();
        expect(again.unchanged).toBeUndefined();

        const charactersOnly = { ...request, filter: {} };
        const withoutGroups = await (await postJson('/api/characters/query', charactersOnly)).json();
        expect(typeof withoutGroups.token).toBe('string');
        const repeat = await (await postJson('/api/characters/query', { ...charactersOnly, ifToken: withoutGroups.token })).json();
        expect(repeat.unchanged).toBe(true);
    });

    test('with includeGroups, hash mode carries the token and answers a matching ifToken unchanged', async () => {
        await seedCharacterWithFile('Vampire.png', cardFor('Vampire Lord'));
        await seedGroup('g1', { name: 'Vampire Coven' });
        for (const request of Object.values(groupRequests)) {
            const json = await settledQuery(request);
            const response = await postJson('/api/characters/query', { ...request, want: ['hashes', 'total'] });
            const token = hashResponseToken(await response.arrayBuffer());
            expect(token).toBe(json.token);
            const again = await postJson('/api/characters/query', { ...request, want: ['hashes', 'total'], ifToken: token });
            expect(await again.json()).toEqual({ seq: json.seq, token, unchanged: true });
        }
    }, 30000);

    test('hash mode carries the token in its trailer and answers a matching ifToken with the JSON unchanged stub', async () => {
        await seedCharacterWithFile('Vampire.png', cardFor('Vampire Lord'));
        for (const filter of [{}, { search: 'vampire' }]) {
            const request = { filter, page: 1, pageSize: 10, want: ['hashes', 'total'] };
            const json = await (await postJson('/api/characters/query', { ...request, want: ['rows', 'total'] })).json();
            const response = await postJson('/api/characters/query', request);
            expect(response.headers.get('content-type')).toContain('application/octet-stream');
            const token = hashResponseToken(await response.arrayBuffer());
            expect(token).toBe(json.token);

            const again = await postJson('/api/characters/query', { ...request, ifToken: token });
            expect(await again.json()).toEqual({ seq: json.seq, token, unchanged: true });
        }
    }, 20000);
});

describe('POST /api/characters/query - sort.field "random" (design doc §5.3, decisions 8/10/13)', () => {
    test('with a seed, orders deterministically and consistently across repeated calls', async () => {
        for (let i = 0; i < 8; i++) {
            await seedCharacter(`Char${i}.png`, { name: `Char${i}`, data: { name: `Char${i}`, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        }

        const first = await (await postJson('/api/characters/query', { sort: { field: 'random', seed: 42 }, page: 1, pageSize: 8 })).json();
        const second = await (await postJson('/api/characters/query', { sort: { field: 'random', seed: 42 }, page: 1, pageSize: 8 })).json();

        expect(first.total).toBe(8);
        expect(first.rows.map(r => r.avatar)).toEqual(second.rows.map(r => r.avatar));
    });

    test('a different seed can produce a different order (not a fresh shuffle per render)', async () => {
        for (let i = 0; i < 8; i++) {
            await seedCharacter(`Char${i}.png`, { name: `Char${i}`, data: { name: `Char${i}`, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        }

        const seedA = await (await postJson('/api/characters/query', { sort: { field: 'random', seed: 1 }, page: 1, pageSize: 8 })).json();
        const seedB = await (await postJson('/api/characters/query', { sort: { field: 'random', seed: 2 }, page: 1, pageSize: 8 })).json();

        expect(seedA.rows.map(r => r.avatar)).not.toEqual(seedB.rows.map(r => r.avatar));
    });

    test('random order paginates without duplicates or gaps when the seed travels on every page', async () => {
        for (let i = 0; i < 9; i++) {
            await seedCharacter(`Char${i}.png`, { name: `Char${i}`, data: { name: `Char${i}`, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        }

        const page1 = await (await postJson('/api/characters/query', { sort: { field: 'random', seed: 7 }, page: 1, pageSize: 3 })).json();
        const page2 = await (await postJson('/api/characters/query', { sort: { field: 'random', seed: 7 }, page: 2, pageSize: 3 })).json();
        const page3 = await (await postJson('/api/characters/query', { sort: { field: 'random', seed: 7 }, page: 3, pageSize: 3 })).json();

        const allAvatars = [...page1.rows, ...page2.rows, ...page3.rows].map(r => r.avatar);
        expect(new Set(allAvatars).size).toBe(9);
    });

    test('with includeGroups, a group added or removed with no character change shows on the next page read', async () => {
        for (let i = 0; i < 4; i++) {
            await seedCharacter(`Char${i}.png`);
        }
        await seedGroup('g1');
        // A seed no other test uses: the random-sort id cache is process-wide.
        const request = { filter: { includeGroups: true }, sort: { field: 'random', seed: 918273 }, page: 1, pageSize: 20 };
        const ids = (body) => body.rows.map(r => r.type === 'group' ? r.item.id : r.item.avatar).sort();

        const first = await (await postJson('/api/characters/query', request)).json();
        expect(ids(first)).toEqual(['Char0.png', 'Char1.png', 'Char2.png', 'Char3.png', 'g1']);

        await seedGroup('g2');
        const added = await (await postJson('/api/characters/query', { ...request, ifToken: first.token })).json();
        expect(added.unchanged).toBeUndefined();
        expect(added.seq).toBe(first.seq);
        expect(ids(added)).toEqual(['Char0.png', 'Char1.png', 'Char2.png', 'Char3.png', 'g1', 'g2']);

        // The group that sorts first, so a page read from ids that still hold it misses the one that sorts last.
        const { getStringHash } = await import('../public/scripts/hash-utils.js');
        const gone = getStringHash('g1', request.sort.seed) < getStringHash('g2', request.sort.seed) ? 'g1' : 'g2';
        const kept = gone === 'g1' ? 'g2' : 'g1';
        fs.unlinkSync(path.join(directories.groups, `${gone}.json`));
        await metadataDb.deleteGroupRow(directories, gone, { fileDeleted: true });
        const removed = await (await postJson('/api/characters/query', { ...request, pageSize: 5, ifToken: added.token })).json();
        expect(removed.unchanged).toBeUndefined();
        expect(removed.seq).toBe(first.seq);
        expect(ids(removed)).toEqual(['Char0.png', 'Char1.png', 'Char2.png', 'Char3.png', kept]);
    });

    test('rejects a non-finite seed with 400', async () => {
        const response = await postJson('/api/characters/query', { sort: { field: 'random', seed: 'not-a-number' } });
        expect(response.status).toBe(400);
    });
});

describe('POST /api/characters/query - filter.search (design doc §5.1/§5)', () => {
    test('finds a seeded, on-disk character by name and returns its shallow row from SQLite', async () => {
        await seedCharacterWithFile('Vampire.png', { name: 'Vampire Lord', data: { name: 'Vampire Lord', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedCharacterWithFile('Werewolf.png', { name: 'Werewolf', data: { name: 'Werewolf', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        const response = await postJson('/api/characters/query', { filter: { search: 'vampire' }, sort: { field: 'search' }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.rows.map(r => r.avatar)).toEqual(['Vampire.png']);
        expect(body.total).toBe(1);
        expect(typeof body.searchBackend).toBe('string');
    });

    test('a fav toggle through setCharacterFav() (not the card file) is reflected by favorites-only search, caught up by incremental maintenance rather than the explicit full-rebuild endpoint', async () => {
        await seedCharacterWithFile('Vampire.png', { name: 'Vampire Lord', data: { name: 'Vampire Lord', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedCharacterWithFile('Werewolf.png', { name: 'Werewolf', data: { name: 'Werewolf', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        // Prime the search index against the pre-toggle state, same as a real server that already answered a
        // search before the user ever favorited anything - this is the from-scratch build every handle's first
        // search pays, not the incremental path this test is actually about.
        await postJson('/api/characters/query', { filter: { search: 'vampire' }, page: 1, pageSize: 10 });

        // The db-authoritative fav write path (character-metadata-db.js's setCharacterFav()) - deliberately never
        // touches Vampire.png's card file, so a search index that (wrongly) rebuilt its `fav` field from the card
        // would never see this, whether by a full rebuild or an incremental catch-up.
        const updated = await metadataDb.setCharacterFav(directories, 'Vampire.png', true);
        expect(updated).toBe(true);

        // The search index worker catches up on its own tick (about once a second) and no request waits for it,
        // so the fix is verified by polling follow-up requests, the same way a real client's next render/search
        // would eventually observe it, never by calling the explicit POST /api/characters/search-index/rebuild
        // repair endpoint.
        let body;
        const deadline = Date.now() + 5000;
        do {
            const response = await postJson('/api/characters/query', { filter: { search: 'vampire', fav: true }, page: 1, pageSize: 10 });
            expect(response.status).toBe(200);
            body = await response.json();
            if (body.rows.length > 0) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        expect(body.rows.map(r => r.avatar)).toEqual(['Vampire.png']);
        expect(body.total).toBe(1);
    }, 20000);

    test('a search term composes with an ordinary column sort, not just sort.field "search"', async () => {
        await seedCharacterWithFile('AVampire.png', { name: 'A Vampire', data: { name: 'A Vampire', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedCharacterWithFile('ZVampire.png', { name: 'Z Vampire', data: { name: 'Z Vampire', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        const response = await postJson('/api/characters/query', { filter: { search: 'vampire' }, sort: { field: 'name', order: 'desc' }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.rows.map(r => r.name)).toEqual(['Z Vampire', 'A Vampire']);
    });

    test('a search term composes with sort.field "random" (decision 23)', async () => {
        await seedCharacterWithFile('Vampire.png', { name: 'Vampire Lord', data: { name: 'Vampire Lord', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        const response = await postJson('/api/characters/query', { filter: { search: 'vampire' }, sort: { field: 'random', seed: 5 }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.rows.map(r => r.avatar)).toEqual(['Vampire.png']);
    });

    test('no matches returns an empty page, not an error', async () => {
        await seedCharacterWithFile('Vampire.png', { name: 'Vampire Lord', data: { name: 'Vampire Lord', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        const response = await postJson('/api/characters/query', { filter: { search: 'nonexistentterm' }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.rows).toEqual([]);
        expect(body.total).toBe(0);
    });

    test('filter.search intersects with filter.ids rather than overriding it', async () => {
        await seedCharacterWithFile('VampireA.png', { name: 'Vampire A', data: { name: 'Vampire A', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedCharacterWithFile('VampireB.png', { name: 'Vampire B', data: { name: 'Vampire B', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        const response = await postJson('/api/characters/query', { filter: { search: 'vampire', ids: ['VampireA.png'] }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.rows.map(r => r.avatar)).toEqual(['VampireA.png']);
    });
});

describe('POST /api/characters/query - filter.search with a fast-field sort (tantivy sorts, groups merged in)', () => {
    /** @param {string} name */
    const cardFor = (name, extra = {}) => ({ name, data: { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } }, ...extra });

    async function seedMixed() {
        await seedCharacterWithFile('a.png', cardFor('Alpha vampire'));
        await seedCharacterWithFile('c.png', cardFor('Charlie vampire'));
        await seedCharacterWithFile('e.png', cardFor('Echo vampire'));
        await seedCharacterWithFile('g.png', cardFor('Golf vampire'));
        await seedCharacterWithFile('x.png', cardFor('Xray werewolf'));
        await seedGroup('grp-b', { name: 'Bravo vampire' });
        await seedGroup('grp-f', { name: 'Foxtrot vampire' });
        await seedGroup('grp-z', { name: 'Zulu vampire' });
        await seedGroup('grp-w', { name: 'Whiskey werewolf' });
    }

    const byNameAsc = ['a.png', 'grp-b', 'c.png', 'e.png', 'grp-f', 'g.png', 'grp-z'];
    const rowId = (r) => r.type === 'group' ? r.item.id : r.item.avatar;

    test('every page of a name-sorted search is the merged order of characters and groups, with the real total', async () => {
        await seedMixed();
        for (const [order, expected] of [['asc', byNameAsc], ['desc', [...byNameAsc].reverse()]]) {
            for (const pageSize of [1, 2, 3, 10]) {
                const ids = [];
                for (let page = 1; page <= Math.ceil(expected.length / pageSize) + 1; page++) {
                    const response = await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'name', order }, page, pageSize });
                    expect(response.status).toBe(200);
                    const body = await response.json();
                    expect(body.total).toBe(expected.length);
                    ids.push(...body.rows.map(rowId));
                }
                expect(ids).toEqual(expected);
            }
        }
    });

    test('filter.fav false keeps only non-favorites on both sides', async () => {
        await seedMixed();
        await seedCharacterWithFile('d.png', cardFor('Delta vampire'));
        await metadataDb.setCharacterFav(directories, 'd.png', true);
        await seedGroup('grp-h', { name: 'Hotel vampire', fav: true });

        let body;
        for (let attempt = 0; attempt < 20; attempt++) {
            body = await (await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'vampire', fav: false }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 10 })).json();
            if (!body.rows.some(r => rowId(r) === 'd.png')) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(body.rows.map(rowId)).toEqual(byNameAsc);
        expect(body.total).toBe(byNameAsc.length);
    });

    test('an index hit whose row no longer exists is omitted and the page still fills', async () => {
        await seedMixed();
        // Prime both indexes, then remove rows without touching the indexes: the group row directly (the groups
        // index follows the groups directory, not the metadata db), the character row without a change-log entry.
        await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 10 });
        await metadataDb.deleteGroupRow(directories, 'grp-b');
        metadataDb.disposeMetadataStores();
        const Database = (await import('better-sqlite3')).default;
        const raw = new Database(path.join(directories.root, 'character-metadata.sqlite'));
        raw.prepare('DELETE FROM characters WHERE id = ?').run('c.png');
        raw.close();

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 3 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.rows.map(rowId)).toEqual(['a.png', 'e.png', 'grp-f']);

        const hashes = await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 3, want: ['hashes', 'total'] });
        expect(hashes.status).toBe(200);
    });
});

describe('search hits whose row no longer exists (the index can lag a delete)', () => {
    const cardFor = (name) => ({ name, data: { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
    const deletedIds = ['gone0.png', 'gone1.png', 'gone2.png'];

    /** Five live matches, and three rows deleted without a change-log entry after the index was built, so their
     * docs stay in the index. The shorter names rank the deleted docs first. */
    async function seedWithGhosts(prime) {
        for (const id of deletedIds) {
            await seedCharacterWithFile(id, cardFor('Vampire'));
        }
        for (let i = 0; i < 5; i++) {
            await seedCharacterWithFile(`live${i}.png`, cardFor(`Vampire lord number ${i}`));
        }
        await prime();
        metadataDb.disposeMetadataStores();
        const Database = (await import('better-sqlite3')).default;
        const raw = new Database(path.join(directories.root, 'character-metadata.sqlite'));
        for (const id of deletedIds) {
            raw.prepare('DELETE FROM characters WHERE id = ?').run(id);
        }
        raw.close();
    }

    const rowId = (r) => r.type === 'group' ? r.item.id : (r.avatar ?? r.item?.avatar);

    test('/query with the search sort omits them and still fills the page', async () => {
        const body = { filter: { search: 'vampire' }, sort: { field: 'search' }, page: 1, pageSize: 5 };
        await seedWithGhosts(() => postJson('/api/characters/query', body));

        const response = await postJson('/api/characters/query', body);
        expect(response.status).toBe(200);
        const ids = (await response.json()).rows.map(rowId);
        expect(ids.sort()).toEqual(['live0.png', 'live1.png', 'live2.png', 'live3.png', 'live4.png']);
    });

    test('/query with the search sort and includeGroups omits them and still fills the page', async () => {
        await seedGroup('grp-v', { name: 'Vampire coven of the long night' });
        const body = { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'search' }, page: 1, pageSize: 6 };
        await seedWithGhosts(() => postJson('/api/characters/query', body));

        const response = await postJson('/api/characters/query', body);
        expect(response.status).toBe(200);
        const ids = (await response.json()).rows.map(rowId);
        expect(ids.sort()).toEqual(['grp-v', 'live0.png', 'live1.png', 'live2.png', 'live3.png', 'live4.png']);
    });

    test('/all with a search omits them and still fills the page', async () => {
        const body = { search: 'vampire', offset: 0, limit: 5 };
        await seedWithGhosts(() => postJson('/api/characters/all', body));

        const response = await postJson('/api/characters/all', body);
        expect(response.status).toBe(200);
        const ids = (await response.json()).items.map(item => item.avatar);
        expect(ids.sort()).toEqual(['live0.png', 'live1.png', 'live2.png', 'live3.png', 'live4.png']);
    });
});

describe('POST /api/characters/query - sort.field "search" applies filters inside the search index, so the page fills', () => {
    const cardFor = (name, description = '') => ({ name, data: { name, description, personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
    const rowId = (r) => r.type === 'group' ? r.item.id : (r.avatar ?? r.item?.avatar);

    // With pageSize 1 the search engine is asked for 1 + pageOverFetch(1) = 6 hits, so six hits ranked above the
    // kept one fill that whole window.
    const aboveCharacterIds = ['above0.png', 'above1.png', 'above2.png', 'above3.png', 'above4.png', 'above5.png'];
    const aboveGroupIds = ['grp-above0', 'grp-above1', 'grp-above2', 'grp-above3', 'grp-above4', 'grp-above5'];

    /** Six characters with the term in their name (boost 20), and kept.png with it only in its description
     * (boost 3), so the six rank above kept.png. */
    async function seedCharacters() {
        for (const id of aboveCharacterIds) {
            await seedCharacterWithFile(id, cardFor('Zephyr'));
        }
        await seedCharacterWithFile('kept.png', cardFor('Plain', 'zephyr'));
    }

    /** Six groups with the term in their name (boost 20), and grp-kept with it only in its members (boost 15),
     * so the six rank above grp-kept. */
    async function seedGroups(aboveOverrides = {}) {
        for (const id of aboveGroupIds) {
            await seedGroup(id, { name: 'Zephyr', ...aboveOverrides });
        }
        await seedGroup('grp-kept', { name: 'Plain', members: ['zephyr.png'] });
    }

    test('fav false: favorited characters ranked above the page don\'t leave it short', async () => {
        await seedCharacters();
        for (const id of aboveCharacterIds) {
            await metadataDb.setCharacterFav(directories, id, true);
        }

        const response = await postJson('/api/characters/query', { filter: { search: 'zephyr', fav: false }, sort: { field: 'search' }, page: 1, pageSize: 1 });
        expect(response.status).toBe(200);
        expect((await response.json()).rows.map(rowId)).toEqual(['kept.png']);
    });

    test('fav false with includeGroups: favorited groups ranked above the page don\'t leave it short', async () => {
        await seedGroups({ fav: true });

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'zephyr', fav: false }, sort: { field: 'search' }, page: 1, pageSize: 1 });
        expect(response.status).toBe(200);
        expect((await response.json()).rows.map(rowId)).toEqual(['grp-kept']);
    });

    test('tags include with includeGroups: untagged groups ranked above the page don\'t leave it short', async () => {
        await seedGroups();
        await metadataDb.assignEntityTag(directories, 'grp-kept', 'tag-kept');

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'zephyr', tags: { include: ['tag-kept'] } }, sort: { field: 'search' }, page: 1, pageSize: 1 });
        expect(response.status).toBe(200);
        expect((await response.json()).rows.map(rowId)).toEqual(['grp-kept']);
    });

    test('ids: characters outside the list ranked above the page don\'t leave it short', async () => {
        await seedCharacters();

        const response = await postJson('/api/characters/query', { filter: { search: 'zephyr', ids: ['kept.png'] }, sort: { field: 'search' }, page: 1, pageSize: 1 });
        expect(response.status).toBe(200);
        expect((await response.json()).rows.map(rowId)).toEqual(['kept.png']);
    });

    test('excludeIds: excluded characters ranked above the page don\'t leave it short', async () => {
        await seedCharacters();

        const response = await postJson('/api/characters/query', { filter: { search: 'zephyr', excludeIds: aboveCharacterIds }, sort: { field: 'search' }, page: 1, pageSize: 1 });
        expect(response.status).toBe(200);
        expect((await response.json()).rows.map(rowId)).toEqual(['kept.png']);
    });
});

describe('POST /api/characters/query - a tag filter with only excluded tags', () => {
    const cardFor = (name) => ({ name, data: { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
    const rowId = (r) => r.type === 'group' ? r.item.id : (r.avatar ?? r.item?.avatar);

    async function seedCharacters() {
        await seedCharacterWithFile('a-tagged.png', cardFor('A zephyr'));
        await seedCharacterWithFile('b-kept.png', cardFor('B zephyr'));
        await seedCharacterWithFile('c-tagged.png', cardFor('C zephyr'));
        await seedCharacterWithFile('d-kept.png', cardFor('D zephyr'));
        await metadataDb.assignEntityTag(directories, 'a-tagged.png', 'tag-x');
        await metadataDb.assignEntityTag(directories, 'c-tagged.png', 'tag-x');
    }

    async function seedGroups() {
        await seedGroup('grp-a-tagged', { name: 'A zephyr' });
        await seedGroup('grp-b-kept', { name: 'B zephyr' });
        await seedGroup('grp-c-tagged', { name: 'C zephyr' });
        await seedGroup('grp-d-kept', { name: 'D zephyr' });
        await metadataDb.assignEntityTag(directories, 'grp-a-tagged', 'tag-x');
        await metadataDb.assignEntityTag(directories, 'grp-c-tagged', 'tag-x');
    }

    test('search sort: characters without the excluded tag come back', async () => {
        await seedCharacters();

        const response = await postJson('/api/characters/query', { filter: { search: 'zephyr', tags: { exclude: ['tag-x'] } }, sort: { field: 'search' }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        expect((await response.json()).rows.map(rowId).sort()).toEqual(['b-kept.png', 'd-kept.png']);
    });

    test('search sort with includeGroups: groups without the excluded tag come back', async () => {
        await seedGroups();

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'zephyr', tags: { exclude: ['tag-x'] } }, sort: { field: 'search' }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        expect((await response.json()).rows.map(rowId).sort()).toEqual(['grp-b-kept', 'grp-d-kept']);
    });

    test('name sort: characters without the excluded tag come back', async () => {
        await seedCharacters();

        const response = await postJson('/api/characters/query', { filter: { search: 'zephyr', tags: { exclude: ['tag-x'] } }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        expect((await response.json()).rows.map(rowId)).toEqual(['b-kept.png', 'd-kept.png']);
    });

    test('name sort with includeGroups: groups without the excluded tag come back', async () => {
        await seedGroups();

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'zephyr', tags: { exclude: ['tag-x'] } }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        expect((await response.json()).rows.map(rowId)).toEqual(['grp-b-kept', 'grp-d-kept']);
    });
});

describe('POST /api/characters/search-index/rebuild (design doc §3.2 explicit repair endpoint)', () => {
    test('forces a rebuild and reports which engine tier served it', async () => {
        await seedCharacterWithFile('Rebuildable.png');

        const response = await postJson('/api/characters/search-index/rebuild', {});
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.ok).toBe(true);
        expect(typeof body.backend).toBe('string');

        // The rebuilt index actually finds the character - not just a 200 with no real effect.
        const searchResponse = await postJson('/api/characters/query', { filter: { search: 'Rebuildable' }, page: 1, pageSize: 10 });
        const searchBody = await searchResponse.json();
        expect(searchBody.rows.map(r => r.avatar)).toEqual(['Rebuildable.png']);
    });
});

describe('POST /api/characters/exists', () => {
    test('returns true/false per requested id, never omitting a key', async () => {
        await seedCharacter('Real.png');

        const response = await postJson('/api/characters/exists', { ids: ['Real.png', 'Fake.png'] });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ 'Real.png': true, 'Fake.png': false });
    });

    test('a deleted character reads as false, never resolving to whatever reused the filename incorrectly', async () => {
        await seedCharacter('Churn.png');
        await metadataDb.deleteCharacterRow(directories, 'Churn.png');

        const response = await postJson('/api/characters/exists', { ids: ['Churn.png'] });
        expect(await response.json()).toEqual({ 'Churn.png': false });
    });

    test('rejects a non-array ids field with 400', async () => {
        const response = await postJson('/api/characters/exists', { ids: 'not-an-array' });
        expect(response.status).toBe(400);
    });

    test('rejects a non-string entry in ids with 400', async () => {
        const response = await postJson('/api/characters/exists', { ids: [123] });
        expect(response.status).toBe(400);
    });

    test('an empty ids array returns an empty object', async () => {
        const response = await postJson('/api/characters/exists', { ids: [] });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({});
    });
});

describe('POST /api/characters/changes', () => {
    test('sinceSeq 0 on an empty store returns no changes and truncated: false', async () => {
        const response = await postJson('/api/characters/changes', { sinceSeq: 0 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.changes).toEqual([]);
        expect(body.truncated).toBe(false);
        expect(body.seq).toBe(0);
        expect(body.hasMore).toBe(false);
    });

    test('reports an upsert then a delete as two ops for the same id, since sinceSeq 0', async () => {
        await seedCharacter('A.png');
        await metadataDb.deleteCharacterRow(directories, 'A.png');

        const response = await postJson('/api/characters/changes', { sinceSeq: 0 });
        const body = await response.json();
        // Collapsed to the latest op for that id within the window (see getChangesSince()'s doc comment).
        expect(body.changes).toEqual([{ id: 'A.png', op: 'delete' }]);
    });

    test('sinceSeq = current seq returns no changes (already caught up)', async () => {
        await seedCharacter('A.png');
        const first = await (await postJson('/api/characters/changes', { sinceSeq: 0 })).json();

        const response = await postJson('/api/characters/changes', { sinceSeq: first.seq });
        const body = await response.json();
        expect(body.changes).toEqual([]);
    });

    test('only returns changes strictly after sinceSeq', async () => {
        await seedCharacter('A.png');
        const afterA = await (await postJson('/api/characters/changes', { sinceSeq: 0 })).json();
        await seedCharacter('B.png', { name: 'B', data: { name: 'B', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        const response = await postJson('/api/characters/changes', { sinceSeq: afterA.seq });
        const body = await response.json();
        expect(body.changes).toEqual([{ id: 'B.png', op: 'upsert', fields: null }]);
    });

    test('rejects a missing/invalid sinceSeq with 400', async () => {
        expect((await postJson('/api/characters/changes', {})).status).toBe(400);
        expect((await postJson('/api/characters/changes', { sinceSeq: -1 })).status).toBe(400);
        expect((await postJson('/api/characters/changes', { sinceSeq: 'nope' })).status).toBe(400);
    });
});

describe('/query sorted pages past the work cap', () => {
    test('the reply has the rows read so far, more and a cursor; following the cursor gives the whole page', async () => {
        for (const name of ['delta', 'alpha', 'echo', 'charlie', 'bravo', 'foxtrot']) await seedCharacter(`${name}.png`);
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        const body = { filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' }, page: 1, pageSize: 4, want: ['rows'] };
        const whole = await (await postJson('/api/characters/query', body)).json();
        expect(whole.more).toBeUndefined();
        expect(whole.rows.map(r => r.item.avatar)).toEqual(['alpha.png', 'bravo.png', 'charlie.png', 'delta.png']);

        metadataDb._setSortedPageWalkForTests({ cap: 1, window: 1 });
        try {
            const rows = [];
            let reply = await (await postJson('/api/characters/query', body)).json();
            rows.push(...reply.rows);
            expect(reply.more).toBe(true);
            expect(typeof reply.cursor).toBe('string');
            for (let requests = 0; requests < 50 && reply.more === true && rows.length < 4; requests++) {
                reply = await (await postJson('/api/characters/query', { ...body, pageSize: 4 - rows.length, cursor: reply.cursor })).json();
                rows.push(...reply.rows);
            }
            expect(rows.map(r => r.item.avatar)).toEqual(['alpha.png', 'bravo.png', 'charlie.png', 'delta.png']);
        } finally {
            metadataDb._setSortedPageWalkForTests(null);
        }
    });
});

describe('/query relevance pages read from the ranking', () => {
    test('pages followed by cursor give the one-page list in rank order, each with the index\'s exact total', async () => {
        const card = name => ({ name, data: { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        for (let i = 0; i < 9; i++) await seedCharacterWithFile(`Zeta${i}.png`, card(i % 3 === 0 ? `Zeta Zeta ${i}` : `Zeta ${i}`));
        await seedGroup('ZetaGroup', { name: 'Zeta Group' });
        await seedGroup('OtherGroup', { name: 'Other Group' });
        const request = { filter: { includeGroups: true, search: 'zeta' }, sort: { field: 'search' }, want: ['rows', 'total'] };
        const key = row => row.type === 'group' ? `group:${row.item.id}` : `character:${row.item.avatar}`;

        const whole = await (await postJson('/api/characters/query', { ...request, page: 1, pageSize: 20 })).json();
        expect(whole.total).toBe(10);
        expect(whole.rows).toHaveLength(10);

        const followed = [];
        let cursor;
        for (let page = 1; page <= 4; page++) {
            const reply = await (await postJson('/api/characters/query', { ...request, page, pageSize: 3, ...(cursor ? { cursor } : {}) })).json();
            expect(reply.total).toBe(10);
            followed.push(...reply.rows.map(key));
            cursor = reply.cursor;
        }
        expect(followed).toEqual(whole.rows.map(key));

        // A page number with no cursor gives the same page.
        const third = await (await postJson('/api/characters/query', { ...request, page: 3, pageSize: 3 })).json();
        expect(third.rows.map(key)).toEqual(whole.rows.map(key).slice(6, 9));
    });
});

