import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// SQLite's ORDER BY compares UTF-8 bytes and JS sort UTF-16 code units; these two ids order differently under
// each (SQLite: HIGH_BMP first, JS: ASTRAL first), so they tell a JS-sorted list from a SQL-ordered one.
const HIGH_BMP = 'tag\uE000';
const ASTRAL = 'tag\u{10000}';
const JS_SORTED = [ASTRAL, HIGH_BMP];

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    const { router: groupsRouter } = await import('../src/endpoints/groups.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/groups', groupsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tag-ids-normalize-group-routes-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
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

test('/api/groups/batch and /api/groups/all send tag_ids in JS sort order', async () => {
    const group = { id: '1001', name: 'Group 1001', members: [], chats: [], fav: false };
    fs.writeFileSync(path.join(directories.groups, '1001.json'), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, '1001', group.name, { fav: false, group });
    for (const tagId of [HIGH_BMP, ASTRAL]) expect(await metadataDb.assignEntityTag(directories, '1001', tagId)).toBe('ok');

    const [batched] = await postJson('/api/groups/batch', { ids: ['1001'] });
    expect(batched.tag_ids).toEqual(JS_SORTED);
    const [fields] = await postJson('/api/groups/batch', { ids: ['1001'], fields: ['tag_ids'] });
    expect(fields.tag_ids).toEqual(JS_SORTED);
    const all = await postJson('/api/groups/all', {});
    expect(all.find(g => g.id === '1001').tag_ids).toEqual(JS_SORTED);
});
