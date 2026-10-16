import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

/** @type {typeof import('../src/saved-views.js')} */
let savedViews;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;

/** A fresh user with an empty store. */
async function makeUser() {
    const made = await fixture.emptyUser('st-saved-views-test-');
    return made;
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    savedViews = await import('../src/saved-views.js');
    fixture = await import('./converted-user.fixture.js');
    const { router } = await import('../src/endpoints/views.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/views', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

/** @type {Awaited<ReturnType<typeof makeUser>>[]} */
let made = [];
beforeEach(async () => {
    user = await makeUser();
    made = [user];
});

afterEach(async () => {
    for (const each of made) await each.close();
});

/** @param {string} route @param {object} body */
async function post(route, body) {
    const response = await fetch(`${baseUrl}/api/views/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
}

/** @param {object} [body] */
async function listNames(body = {}) {
    const names = [];
    let cursor = null;
    for (;;) {
        const { body: page } = await post('list', { ...body, cursor });
        names.push(...page.views.map(v => v.name));
        if (!page.cursor) return names;
        cursor = page.cursor;
    }
}

describe('/api/views', () => {
    test('create adds views in order, get and list read them back', async () => {
        const a = await post('create', { name: 'Elves', view: { text: 'elf', tags: { include: [], exclude: [] } } });
        expect(a.status).toBe(200);
        await post('create', { name: 'Favorites', view: { fav: true } });
        expect(await listNames()).toEqual(['Elves', 'Favorites']);
        const got = await post('get', { id: a.body.id });
        expect(got.body).toMatchObject({ name: 'Elves', view: { text: 'elf' } });
    });

    test('list pages with a cursor and finds names holding the text, ignoring case and accents', async () => {
        for (let i = 0; i < 7; i++) await post('create', { name: `View ${i}`, view: {} });
        await post('create', { name: 'Café crowd', view: {} });
        expect(await listNames({ limit: 3 })).toEqual([...Array.from({ length: 7 }, (_, i) => `View ${i}`), 'Café crowd']);
        expect(await listNames({ contains: 'CAFE' })).toEqual(['Café crowd']);
    });

    test('known answers unchanged while page 1 is the same, and not after any write', async () => {
        const { contentHashOf } = await import('../public/scripts/hash-utils.js');
        const known = async () => contentHashOf((await post('list', {})).body.views);
        let hash = await known();
        expect((await post('list', { known: hash })).body).toEqual({ unchanged: true });
        const { body: made } = await post('create', { name: 'A', view: {} });
        expect((await post('list', { known: hash })).body.unchanged).toBeUndefined();
        hash = await known();
        expect((await post('list', { known: hash })).body).toEqual({ unchanged: true });
        await post('change', { id: made.id, name: 'B' });
        expect((await post('list', { known: hash })).body.unchanged).toBeUndefined();
        hash = await known();
        await post('create', { name: 'C', view: {} });
        const { body: c } = await post('list', {});
        hash = contentHashOf(c.views);
        await post('move', { id: c.views[1].id, anchor: c.views[0].id, side: 'before' });
        expect((await post('list', { known: hash })).body.unchanged).toBeUndefined();
        hash = await known();
        await post('delete', { id: made.id });
        expect((await post('list', { known: hash })).body.unchanged).toBeUndefined();
    });

    test('change renames or replaces the view; one that changes nothing writes nothing', async () => {
        const { body: made } = await post('create', { name: 'A', view: { fav: true } });
        const commit = jest.spyOn(user.store.lib.store, 'commit');
        try {
            expect((await post('change', { id: made.id, name: 'A', view: { fav: true } })).status).toBe(200);
            expect(commit).not.toHaveBeenCalled();
        } finally {
            commit.mockRestore();
        }
        const changed = await post('change', { id: made.id, view: { fav: false } });
        expect(changed.body).toEqual({ id: made.id, name: 'A', view: { fav: false } });
        expect((await post('change', { id: 'nope', name: 'x' })).status).toBe(404);
    });

    test('delete removes one view; deleting it again says nothing was deleted', async () => {
        const { body: made } = await post('create', { name: 'Gone', view: {} });
        await post('create', { name: 'Kept', view: {} });
        expect((await post('delete', { id: made.id })).body).toEqual({ deleted: true });
        expect((await post('delete', { id: made.id })).body).toEqual({ deleted: false });
        expect(await listNames()).toEqual(['Kept']);
    });

    test('move puts a view just before or after another, and keeps working when positions crowd', async () => {
        const ids = {};
        for (const name of ['A', 'B', 'C', 'D']) ids[name] = (await post('create', { name, view: {} })).body.id;
        await post('move', { id: ids.D, anchor: ids.A, side: 'before' });
        expect(await listNames()).toEqual(['D', 'A', 'B', 'C']);
        await post('move', { id: ids.D, anchor: ids.B, side: 'after' });
        expect(await listNames()).toEqual(['A', 'B', 'D', 'C']);
        expect((await post('move', { id: ids.D, anchor: ids.B, side: 'after' })).body).toEqual({ result: 'unchanged' });
        // Halving the same gap again and again runs out of room; the order still comes out right.
        for (let i = 0; i < 70; i++) {
            await post('move', { id: i % 2 ? ids.C : ids.D, anchor: ids.A, side: 'after' });
        }
        const names = await listNames();
        expect(names[0]).toBe('A');
        expect(new Set(names)).toEqual(new Set(['A', 'B', 'C', 'D']));
        expect((await post('move', { id: ids.A, anchor: 'nope', side: 'after' })).status).toBe(404);
    });

    test('bad names, views and moves are refused', async () => {
        expect((await post('create', { name: '  ', view: {} })).status).toBe(400);
        expect((await post('create', { name: 'x'.repeat(201), view: {} })).status).toBe(400);
        expect((await post('create', { name: 'A', view: [] })).status).toBe(400);
        expect((await post('create', { name: 'A', view: { text: 'x'.repeat(70000) } })).status).toBe(400);
        expect((await post('move', { id: 'a', anchor: 'b', side: 'middle' })).status).toBe(400);
        expect((await post('list', { cursor: 'not a cursor' })).status).toBe(400);
    });

    test('each user has their own views', async () => {
        await post('create', { name: 'Mine', view: {} });
        const other = await makeUser();
        made.push(other);
        const mine = user;
        user = other;
        expect(await listNames()).toEqual([]);
        await post('create', { name: 'Theirs', view: {} });
        user = mine;
        expect(await listNames()).toEqual(['Mine']);
    });

    test('every write tells the change stream once', async () => {
        const roots = [];
        const listener = root => roots.push(root);
        savedViews.savedViewsEvents.on('changed', listener);
        try {
            const { body: made } = await post('create', { name: 'A', view: {} });
            await post('change', { id: made.id, name: 'A' });
            await post('change', { id: made.id, name: 'B' });
            await post('delete', { id: made.id });
        } finally {
            savedViews.savedViewsEvents.off('changed', listener);
        }
        expect(roots).toEqual([user.root, user.root, user.root]);
    });
    /** The records of the next commits to the user's store while `act` runs. @param {() => Promise<unknown>} act */
    async function commitsOf(act) {
        const commit = jest.spyOn(user.store.lib.store, 'commit');
        try {
            await act();
            return commit.mock.calls.map(([records]) => records);
        } finally {
            commit.mockRestore();
        }
    }

    const FULL = {
        text: 'elf',
        conditions: [
            { field: 'name', op: 'contains', value: 'a' },
            { field: 'tag', op: 'not_contains', value: '"b c"' },
        ],
        tags: { include: ['t1', 't2'], exclude: ['t3'], mode: 'or' },
        fav: true,
        group: false,
        ranges: { tokens: { min: 1, max: 5 }, chats: { max: 2 } },
        sort: { field: 'search', order: 'asc', tie: { field: 'random', order: 'desc', seed: 7 } },
        folderCase: 'none',
        extra: { deep: [1, { x: null }], also: 'kept' },
        flag: null,
    };

    test('a full view, its conditions, ranges and unknown keys, reads back deep-equal; empty values read as missing', async () => {
        const { body: made } = await post('create', { name: 'Full', view: FULL });
        expect(made).toEqual({ id: made.id, name: 'Full', view: FULL });
        expect((await post('get', { id: made.id })).body).toEqual({ id: made.id, name: 'Full', view: FULL });
        const empty = { text: '', conditions: [], tags: { include: [], exclude: null }, fav: null, ranges: { tokens: {} }, sort: { tie: {} }, folderCase: null };
        const { body: blank } = await post('create', { name: 'Blank', view: empty });
        expect(blank.view).toEqual({});
        expect((await post('get', { id: blank.id })).body.view).toEqual({});
        expect((await post('list', {})).body.views.map(v => Object.keys(v).sort())).toEqual([['id', 'name', 'view'], ['id', 'name', 'view']]);
    });

    test('a change to one leaf commits only that leaf; a condition added, removed or edited writes only its records', async () => {
        const { body: made } = await post('create', { name: 'Full', view: FULL });
        const base = { ...FULL, fav: false };
        const [own] = await commitsOf(() => post('change', { id: made.id, view: base }));
        expect(own).toEqual([expect.objectContaining({ kind: 'jsonValue', json: 'false' })]);
        const added = [...FULL.conditions, { field: 'creator', op: 'contains', value: 'z' }];
        const [add] = await commitsOf(() => post('change', { id: made.id, view: { ...base, conditions: added } }));
        expect(add.map(r => r.kind).sort()).toEqual(['entityCreate', 'itemPlace', 'jsonValue', 'textValue', 'textValue']);
        const edited = added.map((c, i) => (i === 1 ? { ...c, value: '"b d"' } : c));
        const [edit] = await commitsOf(() => post('change', { id: made.id, view: { ...base, conditions: edited } }));
        expect(edit).toEqual([expect.objectContaining({ kind: 'textEdit' })]);
        const removed = edited.filter((_, i) => i !== 0);
        const [remove] = await commitsOf(() => post('change', { id: made.id, view: { ...base, conditions: removed } }));
        expect(remove.map(r => r.kind)).toEqual(['itemDelete', 'entityDelete']);
        expect((await post('get', { id: made.id })).body.view.conditions).toEqual(removed);
    });

    test('crowded moves re-space the views and keep their order, before and after', async () => {
        const ids = {};
        for (const name of ['A', 'B', 'C', 'D']) ids[name] = (await post('create', { name, view: {} })).body.id;
        /** @type {string[]} */
        let want = ['A', 'B', 'C', 'D'];
        const move = async (/** @type {string} */ id, /** @type {string} */ anchor, /** @type {'before' | 'after'} */ side) => {
            await post('move', { id: ids[id], anchor: ids[anchor], side });
            want = want.filter(n => n !== id);
            want.splice(want.indexOf(anchor) + (side === 'after' ? 1 : 0), 0, id);
        };
        // Each move halves the same gap, so the gap runs out on either side.
        for (const [anchor, side] of /** @type {const} */ ([['B', 'before'], ['A', 'after']])) {
            let respaced = 0;
            for (let i = 0; i < 30; i++) {
                const commits = await commitsOf(() => move(i % 2 ? 'C' : 'D', anchor, side));
                if (commits.some(c => c.length > 1)) respaced++;
                expect(await listNames()).toEqual(want);
            }
            expect(respaced).toBeGreaterThan(0);
        }
    });

    test('delete leaves no place, condition or range behind', async () => {
        const { body: made } = await post('create', { name: 'Full', view: FULL });
        const { TYPE } = await import('../src/library-codes.js');
        const lib = user.store.lib;
        const [vid] = await lib.ids(TYPE.view, [made.id]);
        const [stored] = await savedViews.storedViews(lib, [vid]);
        const parts = [...stored.conditions, ...stored.ranges.values()].map(x => x.entity.id);
        expect(parts).toHaveLength(4);
        await post('delete', { id: made.id });
        expect((await lib.entities([vid, ...parts])).every(e => e === null)).toBe(true);
        const holder = await savedViews.viewHolder(lib);
        expect((await lib.store.worldRead('entries', { book: holder, limit: 10 })).entries).toEqual([]);
    });

    test('a tag merged into another reads as it, once within a list and kept across lists', async () => {
        const lib = user.store.lib;
        for (const id of ['old', 'new', 'other']) await lib.tags.create({ id, name: id });
        await lib.tags.delete('old', 'new');
        const { body: made } = await post('create', { name: 'T', view: { tags: { include: ['old', 'new', 'other'], exclude: ['old'] }, folderCase: 'old' } });
        expect((await post('get', { id: made.id })).body.view).toEqual({ tags: { include: ['new', 'other'], exclude: ['new'] }, folderCase: 'new' });
        expect((await post('list', {})).body.views[0].view.tags.include).toEqual(['new', 'other']);
    });

    test('a view that does not fit is refused, saying where and why', async () => {
        const refused = async (/** @type {object} */ view) => {
            const { status, body } = await post('create', { name: 'X', view });
            expect(status).toBe(400);
            expect(body.reason).toBe('invalid-view');
            return body.detail;
        };
        expect(await refused({ conditions: [{ field: 'name', op: 'contains', value: 'a' }, { field: 'name', op: 'is', value: 'a' }] }))
            .toBe('conditions[1]: op is not contains or not_contains');
        expect(await refused({ conditions: [{ field: 'name', op: 'contains', value: 'a', more: 1 }] })).toBe('conditions[0]: has keys a condition doesn\'t have (more)');
        expect(await refused({ conditions: 'name:a' })).toBe('conditions: not a list');
        expect(await refused({ fav: 'yes' })).toBe('fav: not a boolean');
        expect(await refused({ tags: { include: [1] } })).toBe('tags.include: an item isn\'t a string');
        expect(await refused({ sort: { field: 'name', colour: 'red' } })).toBe('sort.colour: not a key a view has');
        expect(await refused({ ranges: { tokens: { min: '1' } } })).toBe('ranges.tokens.min: not a number');
        expect(await listNames()).toEqual([]);
    });
});
