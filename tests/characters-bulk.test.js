import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

// /api/characters/bulk/*: a selection held as rules over the character list (every character a filter matches,
// position ranges of the list, characters picked or left out one by one) is fixed on the server as a job, counted,
// and acted on a batch at a time, with no list of every selected character on the page or in one request.

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
let TYPE;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ TYPE } = await import('../src/library-codes.js'));
    const { router } = await import('../src/endpoints/characters.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await (await import('./converted-user.fixture.js')).emptyUser('st-characters-bulk-test-');
    ({ directories } = user);
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

/** @returns {Promise<{ status: number, body: any, text: string }>} */
async function post(route, body) {
    const response = await fetch(`${baseUrl}/api/characters${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed, text };
}

/** @param {string} route @param {object} body @returns {Promise<any[]>} the NDJSON lines */
async function postLines(route, body) {
    const { status, text } = await post(route, body);
    expect(status).toBe(200);
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** @param {string} avatar @param {boolean} isFav */
async function seedCharacter(avatar, isFav = false) {
    const name = avatar.replace(/\.png$/, '');
    const cardJson = JSON.stringify({
        name,
        fav: isFav,
        data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: isFav, world: '' } },
    });
    await user.store.lib.writeCard(directories, avatar, cardJson);
}

/** Avatars C0000.png .. C{n-1}.png; every third one a favorite. */
async function seedMany(n) {
    /** @type {string[]} */
    const avatars = [];
    for (let i = 0; i < n; i++) avatars.push(`C${String(i).padStart(4, '0')}.png`);
    // Written in one batch of commits, as an import writes a library.
    user.store.lib.beginBatch();
    try {
        for (let i = 0; i < n; i += 100) {
            await Promise.all(avatars.slice(i, i + 100).map((avatar, j) => seedCharacter(avatar, (i + j) % 3 === 0)));
        }
    } finally {
        user.store.lib.endBatch();
    }
    return avatars;
}

/** The list the page shows: every character, by name. */
const LIST = { filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' } };

/** @param {object} selection @returns {Promise<string[]>} every avatar the selection holds */
async function jobAvatars(selection) {
    const avatars = [];
    let after = '';
    for (;;) {
        const { body } = await post('/bulk/ids', { selection, after });
        avatars.push(...body.avatars);
        if (!body.more) return avatars;
        after = body.avatars[body.avatars.length - 1];
    }
}

describe('POST /api/characters/bulk/prepare', () => {
    test('all: every character the filter matches, less those left out, plus those picked', async () => {
        const avatars = await seedMany(30);
        const favs = avatars.filter((_, i) => i % 3 === 0);

        const selection = { query: { filter: { fav: true, includeGroups: true }, sort: LIST.sort }, all: true, exclude: [favs[0]], include: ['C0001.png'] };
        const { status, body } = await post('/bulk/prepare', { selection, current: favs[1] });

        expect(status).toBe(200);
        expect(body.count).toBe(favs.length);
        expect(body.containsCurrent).toBe(true);
        expect(body.missing).toEqual([]);
        expect((await jobAvatars(selection)).sort()).toEqual([...favs.slice(1), 'C0001.png'].sort());
    });

    test('ranges are positions of the list in its own order, across its pages', async () => {
        const avatars = await seedMany(1030);

        const selection = { query: LIST, ranges: [[5, 9], [995, 1004]] };
        const { body } = await post('/bulk/prepare', { selection });

        expect(body.count).toBe(15);
        expect((await jobAvatars(selection)).sort()).toEqual([...avatars.slice(5, 10), ...avatars.slice(995, 1005)].sort());
    }, 60000);

    test('excludeRanges leave positions out of all', async () => {
        const avatars = await seedMany(20);

        const selection = { query: LIST, all: true, excludeRanges: [[0, 4]], include: ['C0002.png'] };
        await post('/bulk/prepare', { selection });

        expect((await jobAvatars(selection)).sort()).toEqual([...avatars.slice(5), 'C0002.png'].sort());
    });

    test('a character picked that no character has is named in missing, and the rest are kept', async () => {
        await seedMany(3);

        const { body } = await post('/bulk/prepare', { selection: { include: ['C0000.png', 'Nobody.png'] } });

        expect(body.count).toBe(1);
        expect(body.missing).toEqual(['Nobody.png']);
    });

    test('rules without the list they are over, and malformed selections, are refused', async () => {
        expect((await post('/bulk/prepare', { selection: { all: true } })).status).toBe(400);
        expect((await post('/bulk/prepare', { selection: { query: LIST, ranges: [[1]] } })).status).toBe(400);
        expect((await post('/bulk/prepare', { selection: { include: ['../x.png'] } })).status).toBe(400);
        expect((await post('/bulk/prepare', {})).status).toBe(400);
    });

    test('the sample is the first avatars of the selection, at most 30', async () => {
        await seedMany(40);
        const { body } = await post('/bulk/prepare', { selection: { query: LIST, all: true } });
        expect(body.count).toBe(40);
        expect(body.sample).toHaveLength(30);
    });
});

describe('POST /api/characters/bulk/run', () => {
    test('fav flips each selected character from its own stored value, a batch at a time, and reports only watched ones', async () => {
        const avatars = await seedMany(1200);
        const selection = { query: LIST, all: true };

        const lines = await postLines('/bulk/run', { selection, action: 'fav', watch: ['C0000.png', 'C0001.png'] });

        expect(lines.filter(line => line.type === 'item')).toEqual([
            { type: 'item', avatar: 'C0000.png', fav: false },
            { type: 'item', avatar: 'C0001.png', fav: true },
        ]);
        // A progress line after each chunk of the run list (1,000 characters).
        expect(lines.filter(line => line.type === 'progress')).toEqual([
            { type: 'progress', done: 1000, failed: 0 },
            { type: 'progress', done: 1200, failed: 0 },
        ]);
        expect(lines[lines.length - 1]).toEqual({ type: 'done', done: 1200, failed: 0 });
        const favs = Object.fromEntries(await Promise.all(avatars.map(async avatar => [avatar, (await user.store.lib.entity(TYPE.character, avatar))?.fav])));
        expect(avatars.filter(avatar => favs[avatar]).length).toBe(1200 - Math.ceil(1200 / 3));
    }, 60000);

    test('delete removes exactly the selected characters', async () => {
        const avatars = await seedMany(12);
        const selection = { query: LIST, ranges: [[2, 6]] };

        const lines = await postLines('/bulk/run', { selection, action: 'delete' });

        expect(lines[lines.length - 1]).toEqual({ type: 'done', done: 5, failed: 0 });
        const exists = Object.fromEntries(await Promise.all(avatars.map(async avatar => [avatar, (await user.store.lib.entity(TYPE.character, avatar)) !== null])));
        expect(avatars.filter(avatar => exists[avatar])).toEqual([...avatars.slice(0, 2), ...avatars.slice(7)]);
    });

    test('a character that failed is named, and the rest are still done', async () => {
        await seedMany(3);
        const selection = { include: ['C0000.png', 'C0001.png'] };
        await post('/bulk/prepare', { selection });
        await user.store.lib.deleteEntity(TYPE.character, 'C0001.png');

        const lines = await postLines('/bulk/run', { selection, action: 'fav' });

        expect(lines.filter(line => line.type === 'failed').map(line => line.avatar)).toEqual(['C0001.png']);
        expect(lines[lines.length - 1]).toEqual({ type: 'done', done: 1, failed: 1 });
    });

    test('tags: add, the shared ones, remove, reset', async () => {
        await seedMany(4);
        for (const id of ['own', 'shared', 'other']) await user.store.lib.writeTag({ id, name: id });
        await user.store.lib.assignTag(TYPE.character, 'C0000.png', 'own', true);
        const selection = { include: ['C0000.png', 'C0001.png', 'C0002.png'] };
        await post('/bulk/prepare', { selection });

        await postLines('/bulk/run', { selection, action: 'tag-add', options: { tagIds: ['shared', 'other'] } });
        expect((await post('/bulk/mutual-tags', { selection })).body.tagIds.sort()).toEqual(['other', 'shared']);

        await postLines('/bulk/run', { selection, action: 'tag-remove', options: { tagIds: ['other'] } });
        expect((await post('/bulk/mutual-tags', { selection })).body.tagIds).toEqual(['shared']);
        const afterRemove = await user.store.lib.tags.tagIdsFor(['C0000.png', 'C0003.png']);
        expect(afterRemove['C0000.png'].sort()).toEqual(['own', 'shared']);
        expect(afterRemove['C0003.png'] ?? []).toEqual([]);

        await postLines('/bulk/run', { selection, action: 'tag-reset' });
        const afterReset = await user.store.lib.tags.tagIdsFor(['C0000.png', 'C0001.png']);
        expect(afterReset['C0000.png'] ?? []).toEqual([]);
        expect(afterReset['C0001.png'] ?? []).toEqual([]);
    });

    test('a run without a selection, or with an unknown action, is a 400', async () => {
        await seedMany(1);
        const selection = { include: ['C0000.png'] };
        // No jobs: the page sends its selection with each request.
        const noSelection = await post('/bulk/run', { job: 'nope', action: 'fav' });
        expect(noSelection.status).toBe(400);
        expect(noSelection.body.reason).toBe('selection-required');
        expect((await post('/bulk/run', { selection, action: 'explode' })).status).toBe(400);
    });
});
