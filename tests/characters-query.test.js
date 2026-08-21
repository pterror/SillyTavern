import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {import('express').Router} */
let router;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
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

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: 'test-user' } };
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
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    directories = { root: tempDir, characters: charactersDir, chats: chatsDir };
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

    test('rejects sort.field "random" with 400 instead of silently falling back to name order', async () => {
        const response = await postJson('/api/characters/query', { sort: { field: 'random' } });
        expect(response.status).toBe(400);
    });

    test('rejects sort.field "search" with 400', async () => {
        const response = await postJson('/api/characters/query', { sort: { field: 'search' } });
        expect(response.status).toBe(400);
    });

    test('rejects filter.search with 400 - full-text search stays on the existing /all endpoint', async () => {
        const response = await postJson('/api/characters/query', { filter: { search: 'vampire' } });
        expect(response.status).toBe(400);
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
