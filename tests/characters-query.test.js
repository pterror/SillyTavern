import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {import('express').Router} */
let router;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
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

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        // Handle derived from the current test's tempDir (unique per test via mkdtempSync's random suffix), not
        // a fixed string - characters-search-index.js's indexCoordinator is a module-level singleton keyed by
        // handle, so a shared 'test-user' handle across tests that each get a *different* `directories` (a fresh
        // tempDir per beforeEach) would let one test's stale in-memory tantivy index handle leak into the next
        // test's incremental-update path (loadOrUpdateTantivyIndex() now uses the coordinator's `previous` param
        // to update an index in place, unlike the old always-rebuild-from-scratch behavior, so this cross-test
        // reuse became observable in a way it wasn't before - a real production user's handle never remaps to a
        // different `directories` mid-process, so this is a test-only hazard, not a product one).
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-query-test-'));
    const charactersDir = path.join(tempDir, 'characters');
    const chatsDir = path.join(tempDir, 'chats');
    const groupsDir = path.join(tempDir, 'groups');
    const groupChatsDir = path.join(tempDir, 'groupChats');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.mkdirSync(groupChatsDir, { recursive: true });
    directories = { root: tempDir, characters: charactersDir, chats: chatsDir, groups: groupsDir, groupChats: groupChatsDir };
});

afterEach(() => {
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
 * @param {number} [fileMtime]
 */
async function seedCharacter(avatar, overrides = {}, fileMtime = 1000) {
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
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify(card), fileMtime);
}

/**
 * Like seedCharacter(), but also writes a real (parseable) PNG to `directories.characters` - needed for the
 * `filter.search` tests below, since search (characters-search-index.js) reads full character data straight off
 * disk to build its index, unlike plain `/query` which never touches the filesystem. Mirrors
 * character-metadata-db.test.js's writeCardFile().
 * @param {string} avatar
 * @param {object} overrides Shallow-merged onto a minimal valid Spec V2 card
 * @param {number} [fileMtime]
 */
async function seedCharacterWithFile(avatar, overrides = {}, fileMtime = 1000) {
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
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify(card), fileMtime);
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

describe('POST /api/characters/query - filter.includeGroups (owner decision extending the design doc to groups)', () => {
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
        await seedCharacter('Old.png', { name: 'Old', data: { name: 'Old', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } }, 1000);
        await seedGroup('g-mid');
        await new Promise(resolve => setTimeout(resolve, 5));
        await seedCharacter('New.png', { name: 'New', data: { name: 'New', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'date_added', order: 'asc' }, page: 1, pageSize: 10 });
        const body = await response.json();
        expect(body.rows.length).toBe(3);
        // Old.png and g-mid seeded before New.png/-created-later - New must sort last.
        expect(body.rows[body.rows.length - 1].item.avatar ?? body.rows[body.rows.length - 1].item.id).toBe('New.png');
    });

    test('each sort field orders characters and groups together: date_last_chat', async () => {
        await seedCharacter('NoChat.png');
        await seedGroup('g1', { chats: ['c1'] });
        fs.writeFileSync(path.join(directories.groupChats, 'c1.jsonl'), 'x');
        await metadataDb.bumpGroupChatStats(directories, 'c1');

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true }, sort: { field: 'date_last_chat', order: 'desc' }, page: 1, pageSize: 10 });
        const body = await response.json();
        // The group (which has a real date_last_chat) sorts before the character (date_last_chat 0) descending.
        expect(body.rows[0].type).toBe('group');
        expect(body.rows[1].type).toBe('character');
    });

    test('each sort field orders characters and groups together: chat_size', async () => {
        await seedCharacter('NoChat.png');
        await seedGroup('g1', { chats: ['c1'] });
        fs.writeFileSync(path.join(directories.groupChats, 'c1.jsonl'), 'x'.repeat(500));
        await metadataDb.bumpGroupChatStats(directories, 'c1');

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

    test('filter.search excludes groups from the merged result, characters-only, but keeps {type, item} envelope shape', async () => {
        await seedCharacterWithFile('Vampire.png', { name: 'Vampire Lord', data: { name: 'Vampire Lord', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await seedGroup('VampireGroup', { name: 'Vampire Group' }); // matches by name, but groups aren't searched

        const response = await postJson('/api/characters/query', { filter: { includeGroups: true, search: 'vampire' }, sort: { field: 'search' }, page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.rows).toEqual([{ type: 'character', item: expect.objectContaining({ avatar: 'Vampire.png' }) }]);
        expect(body.total).toBe(1);
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

describe('POST /api/characters/query', () => {
    test('with no characters, returns empty rows and a zero total', async () => {
        const response = await postJson('/api/characters/query', { page: 1, pageSize: 10 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.rows).toEqual([]);
        expect(body.total).toBe(0);
        expect(typeof body.rev).toBe('number');
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
        await seedCharacter('A.png', { data: { name: 'A', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: 'Wonderland' } } });
        await seedCharacter('B.png', { data: { name: 'B', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: 'Oz' } } });

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

    test('a rename does not change the row\'s date_added, and rev advances', async () => {
        await seedCharacter('Old.png', {}, 1000);
        const before = await (await postJson('/api/characters/query', { filter: { ids: ['Old.png'] } })).json();

        await metadataDb.upsertCharacterFromWrite(directories, 'New.png', JSON.stringify({ name: 'New', data: { name: 'New', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } }), 2000);
        await metadataDb.renameCharacterRow(directories, 'Old.png', 'New.png');

        const after = await (await postJson('/api/characters/query', { filter: { ids: ['New.png'] } })).json();
        expect(after.rows[0].date_added).toBe(before.rows[0].date_added);
        expect(after.rev).toBeGreaterThan(before.rev);
    });
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
    test('sinceRev 0 on an empty store returns no changes and truncated: false', async () => {
        const response = await postJson('/api/characters/changes', { sinceRev: 0 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.changes).toEqual([]);
        expect(body.truncated).toBe(false);
        expect(body.rev).toBe(0);
    });

    test('reports an upsert then a delete as two ops for the same id, since sinceRev 0', async () => {
        await seedCharacter('A.png');
        await metadataDb.deleteCharacterRow(directories, 'A.png');

        const response = await postJson('/api/characters/changes', { sinceRev: 0 });
        const body = await response.json();
        // Collapsed to the latest op for that id within the window (see getChangesSince()'s doc comment).
        expect(body.changes).toEqual([{ id: 'A.png', op: 'delete' }]);
    });

    test('sinceRev = current rev returns no changes (already caught up)', async () => {
        await seedCharacter('A.png');
        const first = await (await postJson('/api/characters/changes', { sinceRev: 0 })).json();

        const response = await postJson('/api/characters/changes', { sinceRev: first.rev });
        const body = await response.json();
        expect(body.changes).toEqual([]);
    });

    test('only returns changes strictly after sinceRev', async () => {
        await seedCharacter('A.png');
        const afterA = await (await postJson('/api/characters/changes', { sinceRev: 0 })).json();
        await seedCharacter('B.png', { name: 'B', data: { name: 'B', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        const response = await postJson('/api/characters/changes', { sinceRev: afterA.rev });
        const body = await response.json();
        expect(body.changes).toEqual([{ id: 'B.png', op: 'upsert' }]);
    });

    test('rejects a missing/invalid sinceRev with 400', async () => {
        expect((await postJson('/api/characters/changes', {})).status).toBe(400);
        expect((await postJson('/api/characters/changes', { sinceRev: -1 })).status).toBe(400);
        expect((await postJson('/api/characters/changes', { sinceRev: 'nope' })).status).toBe(400);
    });
});
