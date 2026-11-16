import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
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
    fixture = await import('./converted-user.fixture.js');
    ({ router } = await import('../src/endpoints/characters.js'));
    ({ router: tagsRouter } = await import('../src/endpoints/tags.js'));
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', router);
    app.use('/api/tags', tagsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-query-folder-test-');
    directories = user.directories;
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

const post = (route, body) => fetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const TAGS = [
    { id: 'closedA', name: 'Closed A', folder_type: 'CLOSED' },
    { id: 'closedB', name: 'Closed B', folder_type: 'CLOSED' },
    { id: 'openC', name: 'Open C', folder_type: 'OPEN' },
    { id: 'plain', name: 'Plain' },
];
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
    for (const tag of TAGS) await user.store.lib.tags.create(tag);
    for (const [id, tags] of Object.entries(CARRIES)) {
        if (id.endsWith('.png')) {
            const cardJson = JSON.stringify({ name: id, data: { name: id, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
            await user.store.lib.writeCard(directories, id, cardJson);
        } else {
            await user.store.lib.writeGroup({ id, name: id, members: [], fav: false });
        }
        for (const tagId of tags) await user.store.lib.tags.assign(id, tagId);
    }
}

/**
 * @param {object} filter
 * @param {object} [sort]
 * @returns {Promise<string[]>} the characters and groups, sorted; folder rows left out
 */
async function listed(filter, sort = { field: 'name', order: 'asc' }) {
    const res = await post('/api/characters/query', { filter: { includeGroups: true, ...filter }, sort, pageSize: 100 });
    expect(res.status).toBe(200);
    const body = await res.json();
    return body.rows.filter(r => r.type !== 'folder').map(r => r.item.avatar ?? r.item.id).sort();
}

/** @param {any} row */
const rowKey = row => (row.type === 'folder' ? `folder:${row.item.id}` : row.item.avatar ?? row.item.id);

/**
 * @param {object} body
 * @returns {Promise<any>}
 */
async function query(body) {
    const res = await post('/api/characters/query', { ...body, filter: { includeGroups: true, ...body.filter } });
    expect(res.status).toBe(200);
    return res.json();
}

/**
 * Every row of the list, read a page at a time, by cursor or by page number.
 * @param {object} filter
 * @param {number} pageSize
 * @param {'cursor'|'page'} by
 */
async function everyRow(filter, pageSize, by, sort = { field: 'name', order: 'asc' }) {
    const seen = [];
    let cursor;
    for (let page = 1; page <= 50; page++) {
        const body = await query({ filter, sort, page, pageSize, ...(by === 'cursor' && cursor ? { cursor } : {}) });
        seen.push(...body.rows.map(rowKey));
        cursor = body.cursor;
        if (by === 'cursor' ? !cursor : body.rows.length < pageSize) break;
    }
    return seen;
}

describe('/query filter.folder', () => {
    test('"none" lists what carries no closed folder; a folder lists what carries its tag, overlap included', async () => {
        await seed();
        expect(await listed({ folder: 'none' })).toEqual(['c0.png', 'c4.png', 'c5.png', 'g1']);
        expect(await listed({ folder: 'closedA' })).toEqual(['c1.png', 'c3.png', 'g0']);
        expect(await listed({ folder: 'closedB' })).toEqual(['c2.png', 'c3.png']);
    });

    test('"none" leads with the closed folders in the tag order asked for, each with what it holds; the total counts them', async () => {
        await seed();
        const body = await query({ filter: { folder: 'none', folderOrder: 'alphabetical' }, sort: { field: 'name', order: 'desc' }, pageSize: 100 });
        expect(body.rows.slice(0, 2)).toEqual([
            { type: 'folder', item: expect.objectContaining({ id: 'closedA', name: 'Closed A', count: 3, countApprox: false }) },
            { type: 'folder', item: expect.objectContaining({ id: 'closedB', name: 'Closed B', count: 2, countApprox: false }) },
        ]);
        expect(typeof body.rows[0].item.thing).toBe('string');
        expect(body.rows.slice(2).every(r => r.type !== 'folder')).toBe(true);
        expect(body.total).toBe(2 + 4);
    });

    test('a closed folder\'s case leads with the one way back to the rest case', async () => {
        await seed();
        const body = await query({ filter: { folder: 'closedA' }, pageSize: 100 });
        expect(body.rows[0]).toEqual({ type: 'folder', item: { id: 'none' } });
        expect(body.rows.slice(1).map(rowKey)).toEqual(['c1.png', 'c3.png', 'g0']);
        expect(body.total).toBe(4);
    });

    test('the folder case combines with tag filters, "or" mode included', async () => {
        await seed();
        expect(await listed({ folder: 'none', tags: { include: ['plain'] } })).toEqual(['c5.png']);
        expect(await listed({ folder: 'closedB', tags: { include: ['plain'] } })).toEqual(['c2.png']);
        expect(await listed({ folder: 'closedA', tags: { include: ['plain', 'closedB'], mode: 'or' } })).toEqual(['c3.png']);
        expect(await listed({ folder: 'none', tags: { exclude: ['openC'] } })).toEqual(['c0.png', 'c5.png', 'g1']);
    });

    test('every sort pages "none" without gaps or repeats, folders first, by cursor and by page number', async () => {
        await seed();
        for (const field of ['name', 'date_added', 'chat_size', 'fav']) {
            for (const order of ['asc', 'desc']) {
                for (const by of /** @type {const} */ (['cursor', 'page'])) {
                    const rows = await everyRow({ folder: 'none', folderOrder: 'alphabetical' }, 2, by, { field, order });
                    expect({ field, order, by, folders: rows.slice(0, 2), rest: rows.slice(2).sort() })
                        .toEqual({ field, order, by, folders: ['folder:closedA', 'folder:closedB'], rest: ['c0.png', 'c4.png', 'c5.png', 'g1'] });
                }
            }
        }
    });

    test('many folders page with the rows after them, a page ending inside the folders or on their last', async () => {
        await seed();
        const many = Array.from({ length: 23 }, (_, i) => `shelf${String(i).padStart(2, '0')}`);
        for (const id of many) await user.store.lib.tags.create({ id, name: `Shelf ${id}`, folder_type: 'CLOSED' });
        const folders = ['closedA', 'closedB', ...many].map(id => `folder:${id}`);
        for (const pageSize of [3, 5, 25, 26]) {
            for (const by of /** @type {const} */ (['cursor', 'page'])) {
                const rows = await everyRow({ folder: 'none', folderOrder: 'alphabetical' }, pageSize, by);
                expect({ pageSize, by, rows }).toEqual({ pageSize, by, rows: [...folders, 'c0.png', 'c4.png', 'c5.png', 'g1'] });
            }
        }
        const third = await query({ filter: { folder: 'none', folderOrder: 'alphabetical' }, page: 3, pageSize: 10 });
        expect(third.rows.map(rowKey)).toEqual([...folders.slice(20), 'c0.png', 'c4.png', 'c5.png', 'g1']);
        expect(third.total).toBe(25 + 4);
    });

    test('a search lists the folders whose name holds every word, and none for a search of other fields', async () => {
        await seed();
        await user.store.lib.tags.create({ id: 'arch', name: 'Archive of Cards', folder_type: 'CLOSED' });
        const folders = async search => (await query({ filter: { folder: 'none', folderOrder: 'alphabetical', search }, pageSize: 100 }))
            .rows.filter(r => r.type === 'folder').map(r => r.item.id);
        expect(await folders('closed')).toEqual(['closedA', 'closedB']);
        expect(await folders('CLOSED b')).toEqual(['closedB']);
        expect(await folders('cards archive')).toEqual(['arch']);
        expect(await folders('name:arch')).toEqual(['arch']);
        expect(await folders('closed -name:a')).toEqual(['closedB']);
        expect(await folders('creator:closed')).toEqual([]);
        const body = await query({ filter: { folder: 'none', search: 'closed' }, pageSize: 100 });
        expect(body.total).toBe(2 + body.rows.filter(r => r.type !== 'folder').length);
    });

    test('the hash answer carries the folder rows ahead of its rows, and the bulk selection counts them as rows', async () => {
        await seed();
        const res = await post('/api/characters/query', { filter: { includeGroups: true, folder: 'none', folderOrder: 'alphabetical' }, sort: { field: 'name', order: 'asc' }, pageSize: 3, want: ['hashes', 'total'] });
        const { deserializeQueryHashesBinary } = await import('../public/scripts/query-hashes-binary.js');
        const decoded = deserializeQueryHashesBinary(await res.arrayBuffer());
        expect(decoded.leadRows.map(r => r.id)).toEqual(['closedA', 'closedB']);
        expect(decoded.hashRows.map(r => r.id)).toEqual(['c0.png']);
        expect(decoded.total).toBe(6);

        const query = { filter: { includeGroups: true, folder: 'none', folderOrder: 'alphabetical' }, sort: { field: 'name', order: 'asc' } };
        const prepared = await (await post('/api/characters/bulk/prepare', { selection: { query, ranges: [[0, 3]] } })).json();
        expect(prepared.sample).toEqual(['c0.png', 'c4.png']);
    });

    test('a tag turned into a closed folder changes the "none" answer and its token', async () => {
        await seed();
        const first = await (await post('/api/characters/query', { filter: { includeGroups: true, folder: 'none' }, pageSize: 100 })).json();
        await user.store.lib.tags.edit('plain', { folder_type: 'CLOSED' });
        const again = await (await post('/api/characters/query', { filter: { includeGroups: true, folder: 'none' }, pageSize: 100, ifToken: first.token })).json();
        expect(again.unchanged).not.toBe(true);
        expect(again.rows.filter(r => r.type !== 'folder').map(r => r.item.avatar ?? r.item.id).sort()).toEqual(['c0.png', 'c4.png', 'g1']);
        expect(again.rows.filter(r => r.type === 'folder').map(r => r.item.id).sort()).toEqual(['closedA', 'closedB', 'plain']);
    });

    test('while no tag is a closed folder, "none" is no filter: every row, with a counted total', async () => {
        await seed();
        for (const id of ['closedA', 'closedB']) await user.store.lib.tags.edit(id, { folder_type: 'OPEN' });
        const body = await (await post('/api/characters/query', { filter: { includeGroups: true, folder: 'none' }, pageSize: 2 })).json();
        expect(body.total).toBe(Object.keys(CARRIES).length);
        expect(body.rows.some(r => r.type === 'folder')).toBe(false);
    });

    test('the route refuses a folder that isn\'t a string, a folder list without groups, and an unknown folder order', async () => {
        await seed();
        expect((await post('/api/characters/query', { filter: { folder: 7, includeGroups: true } })).status).toBe(400);
        expect((await post('/api/characters/query', { filter: { folder: '', includeGroups: true } })).status).toBe(400);
        expect((await post('/api/characters/query', { filter: { folder: 'none' } })).status).toBe(400);
        expect((await post('/api/characters/query', { filter: { folder: 'none', includeGroups: true, folderOrder: 'size' } })).status).toBe(400);
    });

    test('a folder cursor is refused where the list has no folders', async () => {
        await seed();
        const body = await query({ filter: { folder: 'none' }, pageSize: 1 });
        expect(body.cursor.startsWith('f')).toBe(true);
        const refused = await post('/api/characters/query', { filter: { includeGroups: true, folder: 'closedA' }, pageSize: 1, cursor: body.cursor });
        expect(refused.status).toBe(400);
        expect((await refused.json()).reason).toBe('invalid-cursor');
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
