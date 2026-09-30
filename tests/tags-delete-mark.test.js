import { describe, test, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../public/scripts/hash-utils.js')} */
let hashUtils;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-delete-mark-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    hashUtils = await import('../public/scripts/hash-utils.js');
    const { router } = await import('../src/endpoints/tags.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories };
        next();
    });
    app.use('/api/tags', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

afterEach(() => {
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    const dbPath = path.join(tempDir, 'character-metadata.sqlite');
    if (fs.existsSync(dbPath)) {
        fs.rmSync(dbPath);
    }
});

async function post(urlPath, body = {}) {
    return fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function cardJson(name, tags = []) {
    return JSON.stringify({
        name,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: { name, tags, creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } },
    });
}

async function seedCharacter(avatar, tags = []) {
    await metadataDb.upsertCharacterFromWrite(directories, avatar, cardJson(avatar.replace(/\.png$/, ''), tags));
}

async function seedGroup(id) {
    const group = { id, name: id, members: [], fav: false };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, id, { fav: false, group });
}

async function saveTags(ids) {
    await metadataDb.saveTagDefinitions(directories, ids.map(id => ({ id, name: `name-${id}` })));
}

async function assign(id, tagId) {
    expect(await metadataDb.assignEntityTag(directories, id, tagId)).toBe('ok');
}

async function deleteTag(id, mergeInto) {
    const response = await post('/api/tags/delete', mergeInto === undefined ? { id } : { id, mergeInto });
    expect(response.status).toBe(200);
}

async function listedTagIds() {
    const { tags } = await (await post('/api/tags/get')).json();
    return tags.map(t => t.id).sort();
}

async function tagsFor(ids) {
    return (await post('/api/tags/for', { ids })).json();
}

async function withDb(fn) {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(tempDir, 'character-metadata.sqlite'));
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/**
 * Characters: c1 has x, c2 has x and y, c3 has y, c4 has z, c5 has d. Groups: g1 has x, g2 has z.
 */
async function seedLibrary() {
    await saveTags(['x', 'y', 'z', 'd']);
    for (const c of ['c1', 'c2', 'c3', 'c4', 'c5']) await seedCharacter(`${c}.png`);
    await seedGroup('g1');
    await seedGroup('g2');
    await assign('c1.png', 'x');
    await assign('c2.png', 'x');
    await assign('c2.png', 'y');
    await assign('c3.png', 'y');
    await assign('c4.png', 'z');
    await assign('c5.png', 'd');
    await assign('g1', 'x');
    await assign('g2', 'z');
}

async function queryIds(tags) {
    const result = await metadataDb.queryEntities(directories, { tags, sortField: 'name', limit: 100 });
    return { ids: result.rows.map(r => r.id).sort(), total: result.total };
}

describe('POST /api/tags/delete marks the tag and leaves its rows', () => {
    test('the tags row and tag rows stay, a tag_deletions row records the merge target', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');

        await withDb((db) => {
            expect(db.prepare('SELECT id FROM tags WHERE id = ?').get('x')).toEqual({ id: 'x' });
            expect(Array.from(db.prepare('SELECT character_id FROM character_tags WHERE tag_id = ? ORDER BY character_id').iterate('x'), r => r.character_id)).toEqual(['c1.png', 'c2.png']);
            expect(Array.from(db.prepare('SELECT group_id FROM group_tags WHERE tag_id = ?').iterate('x'), r => r.group_id)).toEqual(['g1']);
            expect(Array.from(db.prepare('SELECT tag_id, merge_into FROM tag_deletions').iterate())).toEqual([{ tag_id: 'x', merge_into: 'y' }]);
        });
    });

    test('no merge target records NULL', async () => {
        await seedLibrary();
        await deleteTag('d');
        await withDb((db) => {
            expect(Array.from(db.prepare('SELECT tag_id, merge_into FROM tag_deletions').iterate())).toEqual([{ tag_id: 'd', merge_into: null }]);
        });
    });

    test('an unknown merge target, or the tag itself, deletes with no merge and warns naming it', async () => {
        await seedLibrary();
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await deleteTag('x', 'nope');
        await deleteTag('z', 'z');
        await withDb((db) => {
            expect(Array.from(db.prepare('SELECT tag_id, merge_into FROM tag_deletions ORDER BY tag_id').iterate())).toEqual([
                { tag_id: 'x', merge_into: null },
                { tag_id: 'z', merge_into: null },
            ]);
        });
        const messages = warn.mock.calls.map(args => args.join(' '));
        expect(messages.some(m => m.includes('nope') && m.includes('x'))).toBe(true);
        expect(messages.some(m => m.includes('z'))).toBe(true);
    });

    test('a marked merge target is followed to its own target', async () => {
        await seedLibrary();
        await deleteTag('y', 'z');
        await deleteTag('x', 'y');
        await withDb((db) => {
            expect(db.prepare('SELECT merge_into FROM tag_deletions WHERE tag_id = ?').get('x')).toEqual({ merge_into: 'z' });
        });
    });

    test('marking a tag others merge into moves them onto its target', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        await deleteTag('y', 'z');
        await withDb((db) => {
            expect(Array.from(db.prepare('SELECT tag_id, merge_into FROM tag_deletions ORDER BY tag_id').iterate())).toEqual([
                { tag_id: 'x', merge_into: 'z' },
                { tag_id: 'y', merge_into: 'z' },
            ]);
        });
        expect((await tagsFor(['c1.png', 'c2.png', 'g1']))).toEqual({ 'c1.png': ['z'], 'c2.png': ['z'], g1: ['z'] });
    });

    test('a second delete keeps the first merge target', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        await deleteTag('x', 'z');
        await withDb((db) => {
            expect(db.prepare('SELECT merge_into FROM tag_deletions WHERE tag_id = ?').get('x')).toEqual({ merge_into: 'y' });
        });
    });

    test('deleting an id with no tags row writes nothing', async () => {
        await seedLibrary();
        const before = (await (await post('/api/tags/manifest')).json()).hash;
        await deleteTag('ghost', 'y');
        await withDb((db) => {
            expect(db.prepare('SELECT COUNT(*) AS n FROM tag_deletions').get()).toEqual({ n: 0 });
        });
        expect((await (await post('/api/tags/manifest')).json()).hash).toBe(before);
    });

    test('a non-string mergeInto is a 400', async () => {
        await seedLibrary();
        const response = await post('/api/tags/delete', { id: 'x', mergeInto: 5 });
        expect(response.status).toBe(400);
    });

    test('the delete lands in the tag name change log, for the search index catch-up', async () => {
        await seedLibrary();
        const before = await metadataDb.getCurrentTagNameChangeSeq(directories);
        await deleteTag('x', 'y');
        const page = await metadataDb.getTagNameChangesSince(directories, before);
        expect(page.tagIds).toEqual(['x']);
    });

    test('a tag that merged into the marked one is logged too, since its resolved name changes', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        const before = await metadataDb.getCurrentTagNameChangeSeq(directories);
        await deleteTag('y', 'z');
        const page = await metadataDb.getTagNameChangesSince(directories, before);
        expect(page.tagIds.sort()).toEqual(['x', 'y']);
    });
});

describe('every tag definition read leaves a marked tag out', () => {
    test('/get, /by-ids, /digest, /bucket and /manifest', async () => {
        await seedLibrary();
        const hashBefore = (await (await post('/api/tags/manifest')).json()).hash;
        const digestBefore = await (await post('/api/tags/digest', { bucketCount: 1 })).json();
        await deleteTag('x', 'y');

        expect(await listedTagIds()).toEqual(['d', 'y', 'z']);
        const byIds = (await (await post('/api/tags/by-ids', { ids: ['x', 'y'] })).json()).tags;
        expect(byIds.map(t => t.id)).toEqual(['y']);
        const bucket = await (await post('/api/tags/bucket', { bucket: 0, bucketCount: 1 })).json();
        expect(bucket.members.map(m => m.id).sort()).toEqual(['d', 'y', 'z']);
        const digestAfter = await (await post('/api/tags/digest', { bucketCount: 1 })).json();
        expect(digestAfter).not.toEqual(digestBefore);
        const hashAfter = (await (await post('/api/tags/manifest')).json()).hash;
        expect(hashAfter).not.toBe(hashBefore);
    });

    test('the manifest hash equals one computed without the marked tag', async () => {
        await saveTags(['y', 'z', 'd']);
        const without = (await (await post('/api/tags/manifest')).json()).hash;
        metadataDb.disposeMetadataStores();
        fs.rmSync(path.join(tempDir, 'character-metadata.sqlite'));

        await saveTags(['x', 'y', 'z', 'd']);
        await deleteTag('x', 'y');
        expect((await (await post('/api/tags/manifest')).json()).hash).toBe(without);
    });
});

describe('entity tag lists read a marked tag as its merge target', () => {
    test('/for: x reads as y, once where both are present; a tag with no target is gone', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        await deleteTag('d');
        expect(await tagsFor(['c1.png', 'c2.png', 'c3.png', 'c4.png', 'c5.png', 'g1', 'g2'])).toEqual({
            'c1.png': ['y'], 'c2.png': ['y'], 'c3.png': ['y'], 'c4.png': ['z'], 'c5.png': [], g1: ['y'], g2: ['z'],
        });
    });

    test('/for-all', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        const { avatars, tagIds, map } = await (await post('/api/tags/for-all')).json();
        const byEntity = Object.fromEntries(avatars.map((a, i) => [a, map[i].map(t => tagIds[t]).sort()]));
        expect(byEntity['c1.png']).toEqual(['y']);
        expect(byEntity['c2.png']).toEqual(['y']);
        expect(byEntity.g1).toEqual(['y']);
        expect(tagIds).not.toContain('x');
    });

    test('getCharacterTagIdsByIds, getCharacterTagIds, getGroupTagIds', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        expect(await metadataDb.getCharacterTagIdsByIds(directories, ['c1.png', 'c2.png'])).toEqual({ 'c1.png': ['y'], 'c2.png': ['y'] });
        expect(await metadataDb.getCharacterTagIds(directories, 'c2.png')).toEqual(['y']);
        expect(await metadataDb.getGroupTagIds(directories, 'g1')).toEqual(['y']);
    });

    test('shallow rows: getShallowByIds, queryCharacters rows, queryEntities rows', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        const shallow = await metadataDb.getShallowByIds(directories, ['c1.png', 'c2.png']);
        expect(shallow['c1.png'].tag_ids).toEqual(['y']);
        expect(shallow['c2.png'].tag_ids).toEqual(['y']);

        const chars = await metadataDb.queryCharacters(directories, { sortField: 'name', limit: 100 });
        expect(chars.rows.find(r => r.avatar === 'c1.png').tag_ids).toEqual(['y']);

        const search = await metadataDb.queryCharacters(directories, { sortField: 'search', idOrder: ['c2.png'], limit: 100 });
        expect(search.rows[0].tag_ids).toEqual(['y']);

        const entities = await metadataDb.queryEntities(directories, { sortField: 'name', limit: 100 });
        expect(entities.rows.find(r => r.id === 'c2.png').item.tag_ids).toEqual(['y']);

        const byIds = await metadataDb.getEntityRowsByIds(directories, [{ type: 'character', id: 'c1.png' }]);
        expect(byIds.rows[0].item.tag_ids).toEqual(['y']);
    });

    test('hash rows carry the tag_ids digest of the resolved list', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        const charHash = hashUtils.characterDigestTagIdsHash({ tag_ids: ['y'] });
        const groupHash = hashUtils.groupDigestTagIdsHash({ tag_ids: ['y'] });

        const chars = await metadataDb.queryCharacters(directories, { sortField: 'name', limit: 100, wantRows: false, wantHashes: true });
        expect(chars.hashRows.find(r => r.id === 'c1.png').tagIdsHash).toBe(charHash);
        expect(chars.hashRows.find(r => r.id === 'c2.png').tagIdsHash).toBe(charHash);
        const search = await metadataDb.queryCharacters(directories, { sortField: 'search', idOrder: ['c1.png'], limit: 100, wantRows: false, wantHashes: true });
        expect(search.hashRows[0].tagIdsHash).toBe(charHash);

        const entities = await metadataDb.queryEntities(directories, { sortField: 'name', limit: 100, wantRows: false, wantHashes: true });
        expect(entities.hashRows.find(r => r.id === 'c1.png').tagIdsHash).toBe(charHash);
        expect(entities.hashRows.find(r => r.id === 'g1').tagIdsHash).toBe(groupHash);

        const random = await metadataDb.queryEntities(directories, { sortField: 'random', seed: 3, handle: 'h', limit: 100, wantRows: false, wantHashes: true });
        expect(random.hashRows.find(r => r.id === 'g1').tagIdsHash).toBe(groupHash);

        const byIds = await metadataDb.getEntityRowsByIds(directories, [{ type: 'character', id: 'c1.png' }, { type: 'group', id: 'g1' }], { wantRows: false, wantHashes: true });
        expect(byIds.hashRows.map(r => r.tagIdsHash)).toEqual([charHash, groupHash]);
    });
});

describe('tag filters read a marked tag as its merge target', () => {
    test('include y matches rows of x, for characters and groups', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        expect(await queryIds({ include: ['y'] })).toEqual({ ids: ['c1.png', 'c2.png', 'c3.png', 'g1'], total: 4 });
    });

    test('include x acts on y', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        expect(await queryIds({ include: ['x'] })).toEqual({ ids: ['c1.png', 'c2.png', 'c3.png', 'g1'], total: 4 });
    });

    test('and-mode counts x and y as one tag', async () => {
        await seedLibrary();
        await assign('c1.png', 'z');
        await deleteTag('x', 'y');
        expect(await queryIds({ include: ['y', 'z'], mode: 'and' })).toEqual({ ids: ['c1.png'], total: 1 });
        expect(await queryIds({ include: ['x', 'y'], mode: 'and' })).toEqual({ ids: ['c1.png', 'c2.png', 'c3.png', 'g1'], total: 4 });
    });

    test('exclude y also excludes rows of x', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        expect(await queryIds({ exclude: ['y'] })).toEqual({ ids: ['c4.png', 'c5.png', 'g2'], total: 3 });
    });

    test('a tag deleted with no target: include matches nothing, or-mode drops it, exclude drops nothing', async () => {
        await seedLibrary();
        await deleteTag('d');
        expect(await queryIds({ include: ['d'] })).toEqual({ ids: [], total: 0 });
        expect(await queryIds({ include: ['d', 'z'], mode: 'and' })).toEqual({ ids: [], total: 0 });
        expect(await queryIds({ include: ['d', 'z'], mode: 'or' })).toEqual({ ids: ['c4.png', 'g2'], total: 2 });
        expect(await queryIds({ exclude: ['d'] })).toEqual({ ids: ['c1.png', 'c2.png', 'c3.png', 'c4.png', 'c5.png', 'g1', 'g2'], total: 7 });
    });

    test('an id list plus a tag filter (the per-row form)', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        const result = await metadataDb.queryEntities(directories, { ids: ['c1.png', 'c4.png', 'g1'], tags: { include: ['y'] }, sortField: 'name', limit: 100 });
        expect(result.rows.map(r => r.id).sort()).toEqual(['c1.png', 'g1']);
        const andResult = await metadataDb.queryCharacters(directories, { ids: ['c1.png', 'c2.png'], tags: { include: ['x', 'y'], mode: 'and' }, sortField: 'name', limit: 100 });
        expect(andResult.rows.map(r => r.avatar).sort()).toEqual(['c1.png', 'c2.png']);
    });
});

describe('usage counts', () => {
    test('/usage adds x into y, leaves x out, and lists y as approximate', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        await deleteTag('d');
        const response = await fetch(`${baseUrl}/api/tags/usage`);
        const counts = await response.json();
        expect(counts.x).toBeUndefined();
        expect(counts.d).toBeUndefined();
        expect(counts.y).toBe(5);
        expect(counts.z).toBe(2);
        expect(JSON.parse(response.headers.get('X-Tag-Usage-Approximate'))).toEqual(['y']);
    });

    test('with nothing merging, the approximate list is empty', async () => {
        await seedLibrary();
        const response = await fetch(`${baseUrl}/api/tags/usage`);
        expect(JSON.parse(response.headers.get('X-Tag-Usage-Approximate'))).toEqual([]);
    });

    test('unused-tag count and prune leave marked tags alone and keep a target used only through x', async () => {
        await saveTags(['x', 'y', 'u']);
        await seedCharacter('c1.png');
        await assign('c1.png', 'x');
        await deleteTag('x', 'y');
        expect((await (await post('/api/tags/unused-count')).json()).count).toBe(1);
        const pruned = await (await post('/api/tags/prune', { limit: 10 })).json();
        expect(pruned.deleted).toEqual(['u']);
        await withDb((db) => {
            expect(Array.from(db.prepare('SELECT id FROM tags ORDER BY id').iterate(), r => r.id)).toEqual(['x', 'y']);
        });
    });
});

describe('writes that name a marked tag', () => {
    test('saveTagDefinitions and /edit skip a marked id and warn naming it', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await metadataDb.saveTagDefinitions(directories, ['x', 'y', 'z', 'd'].map(id => ({ id, name: `name-${id}` })));
        const edited = await post('/api/tags/edit', { id: 'x', patch: { name: 'renamed' } });
        expect(await edited.json()).toEqual({ result: 'ok', refused: [{ id: 'x', reason: 'deleted' }] });
        expect(await listedTagIds()).toEqual(['d', 'y', 'z']);
        await withDb((db) => {
            expect(db.prepare('SELECT id FROM tags WHERE id = ?').get('x')).toBeUndefined();
            expect(Array.from(db.prepare('SELECT tag_id FROM tag_deletions').iterate())).toEqual([{ tag_id: 'x' }]);
        });
        const messages = warn.mock.calls.map(args => args.join(' '));
        expect(messages.filter(m => m.includes('x')).length).toBeGreaterThanOrEqual(2);
    });

    test('assign x writes y; assign of a tag with no target writes nothing and warns', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        await deleteTag('d');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await assign('c4.png', 'x');
        await assign('g2', 'x');
        await assign('c4.png', 'd');
        await withDb((db) => {
            expect(Array.from(db.prepare('SELECT tag_id FROM character_tags WHERE character_id = ? ORDER BY tag_id').iterate('c4.png'), r => r.tag_id)).toEqual(['y', 'z']);
            expect(Array.from(db.prepare('SELECT tag_id FROM group_tags WHERE group_id = ? ORDER BY tag_id').iterate('g2'), r => r.tag_id)).toEqual(['y', 'z']);
        });
        expect(warn.mock.calls.map(args => args.join(' ')).some(m => m.includes('d') && m.includes('c4.png'))).toBe(true);
    });

    test('/assign-many maps x to y and drops a tag with no target, warning', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        await deleteTag('d');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const response = await post('/api/tags/assign-many', { tagIdsByEntity: { 'c4.png': ['x', 'y', 'd'], g2: ['x'] } });
        expect(response.status).toBe(200);
        await withDb((db) => {
            expect(Array.from(db.prepare('SELECT tag_id FROM character_tags WHERE character_id = ?').iterate('c4.png'), r => r.tag_id)).toEqual(['y']);
            expect(Array.from(db.prepare('SELECT tag_id FROM group_tags WHERE group_id = ?').iterate('g2'), r => r.tag_id)).toEqual(['y']);
        });
        expect(warn.mock.calls.map(args => args.join(' ')).some(m => m.includes('d') && m.includes('c4.png'))).toBe(true);
    });

    test('unassign x removes only the x row, so an entity that also has y keeps it', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        expect(await metadataDb.unassignEntityTag(directories, 'c2.png', 'x')).toBe('ok');
        expect(await metadataDb.unassignEntityTag(directories, 'c1.png', 'x')).toBe('ok');
        expect(await tagsFor(['c1.png', 'c2.png'])).toEqual({ 'c1.png': [], 'c2.png': ['y'] });
    });

    test('a card tag named like x resolves to y', async () => {
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        await saveTags(['x', 'y']);
        await deleteTag('x', 'y');
        await seedCharacter('card.png', ['name-x']);
        const seeded = await metadataDb.seedCardTagsForSingleCharacter(directories, 'card.png');
        expect(seeded.tagIds).toEqual(['y']);
        expect(seeded.tagDefinitions.map(t => t.id)).toEqual(['y']);
        expect(await tagsFor(['card.png'])).toEqual({ 'card.png': ['y'] });
    });

    test('a card tag named like a tag deleted with no target does not resolve to it', async () => {
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        await saveTags(['d']);
        await deleteTag('d');
        await seedCharacter('card.png', ['name-d']);
        const seeded = await metadataDb.seedCardTagsForSingleCharacter(directories, 'card.png');
        expect(seeded.tagIds).toHaveLength(1);
        expect(seeded.tagIds[0]).not.toBe('d');
        expect(seeded.tagDefinitions[0].name).toBe('name-d');
    });
});

describe('POST /api/tags/create and /api/tags/edit', () => {
    test('bad input is a 400 and writes nothing', async () => {
        await saveTags(['a']);
        const cases = [
            ['/api/tags/create', {}],
            ['/api/tags/create', { tag: null }],
            ['/api/tags/create', { tag: 'a' }],
            ['/api/tags/create', { tag: { name: 'no id' } }],
            ['/api/tags/create', { tag: { id: '' } }],
            ['/api/tags/create', { tag: { id: 5 } }],
            ['/api/tags/edit', { patch: { name: 'n' } }],
            ['/api/tags/edit', { id: '', patch: { name: 'n' } }],
            ['/api/tags/edit', { id: 5, patch: { name: 'n' } }],
            ['/api/tags/edit', { id: 'a' }],
            ['/api/tags/edit', { id: 'a', patch: null }],
            ['/api/tags/edit', { id: 'a', patch: ['n'] }],
            ['/api/tags/edit', { id: 'a', patch: 'n' }],
            ['/api/tags/edit', { id: 'a', patch: { id: 'b', name: 'n' } }],
        ];
        for (const [url, body] of cases) {
            const response = await post(url, body);
            expect({ url, body, status: response.status }).toEqual({ url, body, status: 400 });
        }
        await withDb((db) => {
            expect(Array.from(db.prepare('SELECT id, data FROM tags').iterate())).toEqual([{ id: 'a', data: JSON.stringify({ id: 'a', name: 'name-a' }) }]);
        });
    });

    test('create answers { result, refused }: empty when created, exists, deleted', async () => {
        await saveTags(['m']);
        await deleteTag('m');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const created = await post('/api/tags/create', { tag: { id: 'n', name: 'New' } });
        expect(created.status).toBe(200);
        expect(await created.json()).toEqual({ result: 'ok', refused: [] });
        expect(await (await post('/api/tags/create', { tag: { id: 'n', name: 'Again' } })).json()).toEqual({ result: 'ok', refused: [{ id: 'n', reason: 'exists' }] });
        expect(await (await post('/api/tags/create', { tag: { id: 'm', name: 'Back' } })).json()).toEqual({ result: 'ok', refused: [{ id: 'm', reason: 'deleted' }] });
        await withDb((db) => {
            expect(JSON.parse(db.prepare('SELECT data FROM tags WHERE id = ?').get('n').data)).toEqual({ id: 'n', name: 'New', sort_order: 1 });
        });
    });

    test('edit answers { result, refused }: empty when merged, missing, deleted, unreadable', async () => {
        await saveTags(['a', 'm', 'u']);
        await deleteTag('m');
        await withDb(db => db.prepare('UPDATE tags SET data = ? WHERE id = ?').run('{not json', 'u'));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const edited = await post('/api/tags/edit', { id: 'a', patch: { id: 'a', color: 'red' } });
        expect(edited.status).toBe(200);
        expect(await edited.json()).toEqual({ result: 'ok', refused: [] });
        expect(await (await post('/api/tags/edit', { id: 'ghost', patch: { name: 'G' } })).json()).toEqual({ result: 'ok', refused: [{ id: 'ghost', reason: 'missing' }] });
        expect(await (await post('/api/tags/edit', { id: 'm', patch: { name: 'M' } })).json()).toEqual({ result: 'ok', refused: [{ id: 'm', reason: 'deleted' }] });
        expect(await (await post('/api/tags/edit', { id: 'u', patch: { name: 'U' } })).json()).toEqual({ result: 'ok', refused: [{ id: 'u', reason: 'unreadable' }] });
        await withDb((db) => {
            expect(JSON.parse(db.prepare('SELECT data FROM tags WHERE id = ?').get('a').data)).toEqual({ id: 'a', name: 'name-a', color: 'red' });
            expect(db.prepare('SELECT id FROM tags WHERE id = ?').get('ghost')).toBeUndefined();
        });
    });
});
