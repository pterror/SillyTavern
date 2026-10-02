import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('express').Router} */
let router;
/** @type {import('express').Router} */
let tagsRouter;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    ({ router } = await import('../src/endpoints/characters.js'));
    ({ router: tagsRouter } = await import('../src/endpoints/tags.js'));
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/characters', router);
    app.use('/api/tags', tagsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-query-folder-test-'));
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

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

const post = (route, body) => fetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Tags: two closed folders, one open folder, one plain tag.
const TAGS = [
    { id: 'closedA', name: 'Closed A', folder_type: 'CLOSED' },
    { id: 'closedB', name: 'Closed B', folder_type: 'CLOSED' },
    { id: 'openC', name: 'Open C', folder_type: 'OPEN' },
    { id: 'plain', name: 'Plain' },
];
// Which tags each character carries; c3 is in both closed folders.
const CARRIES = {
    'c0.png': [],
    'c1.png': ['closedA'],
    'c2.png': ['closedB', 'plain'],
    'c3.png': ['closedA', 'closedB'],
    'c4.png': ['openC'],
    'c5.png': ['plain'],
    g0: ['closedA'],
    g1: [],
};

async function seed() {
    for (const tag of TAGS) await metadataDb.createTagDefinition(directories, tag);
    for (const [id, tags] of Object.entries(CARRIES)) {
        if (id.endsWith('.png')) {
            const cardJson = JSON.stringify({ name: id, data: { name: id, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
            await metadataDb.upsertCharacterFromWrite(directories, id, cardJson);
        } else {
            const group = { id, name: id, members: [], chats: [], fav: false };
            fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
            await metadataDb.upsertGroupRow(directories, id, id, { fav: false, group });
        }
        for (const tagId of tags) await metadataDb.assignEntityTag(directories, id, tagId);
    }
    await metadataDb.fillTagNameKeysIfNeeded(directories);
    await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
}

/** @param {object} filter @param {object} [sort] */
async function listed(filter, sort = { field: 'name', order: 'asc' }) {
    const res = await post('/api/characters/query', { filter: { includeGroups: true, ...filter }, sort, pageSize: 100 });
    expect(res.status).toBe(200);
    const body = await res.json();
    return body.rows.map(r => r.item.avatar ?? r.item.id).sort();
}

describe('/query filter.folder', () => {
    test('"none" lists what carries no closed folder; a folder lists what carries its tag, overlap included', async () => {
        await seed();
        expect(await listed({ folder: 'none' })).toEqual(['c0.png', 'c4.png', 'c5.png', 'g1']);
        expect(await listed({ folder: 'closedA' })).toEqual(['c1.png', 'c3.png', 'g0']);
        expect(await listed({ folder: 'closedB' })).toEqual(['c2.png', 'c3.png']);
    });

    test('the folder case combines with tag filters, "or" mode included', async () => {
        await seed();
        expect(await listed({ folder: 'none', tags: { include: ['plain'] } })).toEqual(['c5.png']);
        expect(await listed({ folder: 'closedB', tags: { include: ['plain'] } })).toEqual(['c2.png']);
        expect(await listed({ folder: 'closedA', tags: { include: ['plain', 'closedB'], mode: 'or' } })).toEqual(['c3.png']);
        expect(await listed({ folder: 'none', tags: { exclude: ['openC'] } })).toEqual(['c0.png', 'c5.png', 'g1']);
    });

    test('every sort pages "none" without gaps or repeats', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        for (const field of ['name', 'date_added', 'chat_size', 'fav']) {
            for (const order of ['asc', 'desc']) {
                const seen = [];
                let cursor;
                for (let page = 1; page <= 5; page++) {
                    const res = await post('/api/characters/query', { filter: { includeGroups: true, folder: 'none' }, sort: { field, order }, page, pageSize: 2, cursor });
                    const body = await res.json();
                    seen.push(...body.rows.map(r => r.item.avatar ?? r.item.id));
                    cursor = body.cursor;
                    if (body.rows.length < 2 && !body.more) break;
                }
                expect({ field, order, rows: [...seen].sort() }).toEqual({ field, order, rows: ['c0.png', 'c4.png', 'c5.png', 'g1'] });
            }
        }
    });

    test('a tag turned into a closed folder changes the "none" answer and its token', async () => {
        await seed();
        const first = await (await post('/api/characters/query', { filter: { includeGroups: true, folder: 'none' }, pageSize: 100 })).json();
        await metadataDb.editTagDefinition(directories, 'plain', { folder_type: 'CLOSED' });
        const again = await (await post('/api/characters/query', { filter: { includeGroups: true, folder: 'none' }, pageSize: 100, ifToken: first.token })).json();
        expect(again.unchanged).not.toBe(true);
        expect(again.rows.map(r => r.item.avatar ?? r.item.id).sort()).toEqual(['c0.png', 'c4.png', 'g1']);
    });

    test('the route refuses a folder that isn\'t a string', async () => {
        await seed();
        expect((await post('/api/characters/query', { filter: { folder: 7 } })).status).toBe(400);
        expect((await post('/api/characters/query', { filter: { folder: '' } })).status).toBe(400);
    });
});

describe('/api/tags/query filter.folderType', () => {
    test('lists only the folders of that type', async () => {
        await seed();
        const ids = async folderType => (await (await post('/api/tags/query', { filter: { folderType }, sort: { field: 'alphabetical' }, pageSize: 50 })).json()).rows.map(t => t.id).sort();
        expect(await ids('CLOSED')).toEqual(['closedA', 'closedB']);
        expect(await ids('OPEN')).toEqual(['openC']);
        expect((await post('/api/tags/query', { filter: { folderType: 'SHUT' } })).status).toBe(400);
    });
});
