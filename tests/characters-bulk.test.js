import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// /api/characters/bulk/*: a selection held as rules over the character list (every character a filter matches,
// position ranges of the list, characters picked or left out one by one) is fixed on the server as a job, counted,
// and acted on a batch at a time, with no list of every selected character on the page or in one request.

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    const { router } = await import('../src/endpoints/characters.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-bulk-test-'));
    directories = /** @type {any} */ ({
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
        thumbnailsAvatar: path.join(tempDir, 'thumbnails', 'avatar'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats, directories.thumbnailsAvatar]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

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
    await metadataDb.upsertCharacterFromWrite(directories, avatar, cardJson);
}

/** Avatars C0000.png .. C{n-1}.png; every third one a favorite. */
async function seedMany(n) {
    /** @type {string[]} */
    const avatars = [];
    for (let i = 0; i < n; i++) {
        const avatar = `C${String(i).padStart(4, '0')}.png`;
        await seedCharacter(avatar, i % 3 === 0);
        avatars.push(avatar);
    }
    return avatars;
}

/** The list the page shows: every character, by name. */
const LIST = { filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' } };

/** @param {string} job @returns {Promise<string[]>} every avatar the job holds */
async function jobAvatars(job) {
    const avatars = [];
    let after = '';
    for (;;) {
        const { body } = await post('/bulk/ids', { job, after });
        avatars.push(...body.avatars);
        if (!body.more) return avatars;
        after = body.avatars[body.avatars.length - 1];
    }
}

describe('POST /api/characters/bulk/prepare', () => {
    test('all: every character the filter matches, less those left out, plus those picked', async () => {
        const avatars = await seedMany(30);
        const favs = avatars.filter((_, i) => i % 3 === 0);

        const { status, body } = await post('/bulk/prepare', {
            selection: { query: { filter: { fav: true, includeGroups: true }, sort: LIST.sort }, all: true, exclude: [favs[0]], include: ['C0001.png'] },
            current: favs[1],
        });

        expect(status).toBe(200);
        expect(body.count).toBe(favs.length);
        expect(body.containsCurrent).toBe(true);
        expect(body.missing).toEqual([]);
        expect((await jobAvatars(body.job)).sort()).toEqual([...favs.slice(1), 'C0001.png'].sort());
    });

    test('ranges are positions of the list in its own order, across its pages', async () => {
        const avatars = await seedMany(1030);

        const { body } = await post('/bulk/prepare', { selection: { query: LIST, ranges: [[5, 9], [995, 1004]] } });

        expect(body.count).toBe(15);
        expect((await jobAvatars(body.job)).sort()).toEqual([...avatars.slice(5, 10), ...avatars.slice(995, 1005)].sort());
    });

    test('excludeRanges leave positions out of all', async () => {
        const avatars = await seedMany(20);

        const { body } = await post('/bulk/prepare', { selection: { query: LIST, all: true, excludeRanges: [[0, 4]], include: ['C0002.png'] } });

        expect((await jobAvatars(body.job)).sort()).toEqual([...avatars.slice(5), 'C0002.png'].sort());
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
        const { body: prepared } = await post('/bulk/prepare', { selection: { query: LIST, all: true } });

        const lines = await postLines('/bulk/run', { job: prepared.job, action: 'fav', watch: ['C0000.png', 'C0001.png'] });

        expect(lines.filter(line => line.type === 'item')).toEqual([
            { type: 'item', avatar: 'C0000.png', fav: false },
            { type: 'item', avatar: 'C0001.png', fav: true },
        ]);
        expect(lines.filter(line => line.type === 'progress').length).toBeGreaterThanOrEqual(3);
        expect(lines[lines.length - 1]).toEqual({ type: 'done', done: 1200, failed: 0 });
        const favs = await metadataDb.getCharacterFavsByIds(directories, avatars);
        expect(avatars.filter(avatar => favs[avatar]).length).toBe(1200 - Math.ceil(1200 / 3));
    });

    test('delete removes exactly the selected characters, and the job outlives it until dropped', async () => {
        const avatars = await seedMany(12);
        const { body: prepared } = await post('/bulk/prepare', { selection: { query: LIST, ranges: [[2, 6]] } });

        const lines = await postLines('/bulk/run', { job: prepared.job, action: 'delete' });

        expect(lines[lines.length - 1]).toEqual({ type: 'done', done: 5, failed: 0 });
        const exists = await metadataDb.checkCharactersExist(directories, avatars);
        expect(avatars.filter(avatar => exists[avatar])).toEqual([...avatars.slice(0, 2), ...avatars.slice(7)]);

        expect((await jobAvatars(prepared.job))).toHaveLength(5);
        expect((await post('/bulk/drop', { job: prepared.job })).status).toBe(204);
        expect((await post('/bulk/ids', { job: prepared.job })).status).toBe(404);
    });

    test('a character that failed is named, and the rest are still done', async () => {
        await seedMany(3);
        const { body: prepared } = await post('/bulk/prepare', { selection: { include: ['C0000.png', 'C0001.png'] } });
        await metadataDb.deleteCharacterRow(directories, 'C0001.png');

        const lines = await postLines('/bulk/run', { job: prepared.job, action: 'fav' });

        expect(lines.filter(line => line.type === 'failed').map(line => line.avatar)).toEqual(['C0001.png']);
        expect(lines[lines.length - 1]).toEqual({ type: 'done', done: 1, failed: 1 });
    });

    test('tags: add, the shared ones, remove, reset', async () => {
        await seedMany(4);
        await metadataDb.assignEntityTag(directories, 'C0000.png', 'own');
        const { body: prepared } = await post('/bulk/prepare', { selection: { include: ['C0000.png', 'C0001.png', 'C0002.png'] } });

        await postLines('/bulk/run', { job: prepared.job, action: 'tag-add', options: { tagIds: ['shared', 'other'] } });
        expect((await post('/bulk/mutual-tags', { job: prepared.job })).body.tagIds.sort()).toEqual(['other', 'shared']);

        await postLines('/bulk/run', { job: prepared.job, action: 'tag-remove', options: { tagIds: ['other'] } });
        expect((await post('/bulk/mutual-tags', { job: prepared.job })).body.tagIds).toEqual(['shared']);
        const afterRemove = await metadataDb.getEntityTagIdsForMany(directories, ['C0000.png', 'C0003.png']);
        expect(afterRemove['C0000.png'].sort()).toEqual(['own', 'shared']);
        expect(afterRemove['C0003.png'] ?? []).toEqual([]);

        await postLines('/bulk/run', { job: prepared.job, action: 'tag-reset' });
        const afterReset = await metadataDb.getEntityTagIdsForMany(directories, ['C0000.png', 'C0001.png']);
        expect(afterReset['C0000.png'] ?? []).toEqual([]);
        expect(afterReset['C0001.png'] ?? []).toEqual([]);
    });

    test('an unknown job is a 404, an unknown action a 400', async () => {
        await seedMany(1);
        const { body: prepared } = await post('/bulk/prepare', { selection: { include: ['C0000.png'] } });
        expect((await post('/bulk/run', { job: 'nope', action: 'fav' })).status).toBe(404);
        expect((await post('/bulk/run', { job: prepared.job, action: 'explode' })).status).toBe(400);
    });
});
