import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import path from 'node:path';
import { storedTagDefinitions, tagCounts } from './tag-store-reads.js';

// A tag deleted with a merge target: its carriers carry the target, every read follows the merge, and the writes that
// name the deleted tag act on the target.

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../public/scripts/hash-utils.js')} */
let hashUtils;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    fixture = await import('./converted-user.fixture.js');
    hashUtils = await import('../public/scripts/hash-utils.js');
    const { router } = await import('../src/endpoints/tags.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/tags', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-tags-delete-mark-test-');
    directories = user.directories;
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(async () => {
    jest.restoreAllMocks();
    await user.close();
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
    await user.store.lib.writeCard(directories, avatar, cardJson(avatar.replace(/\.png$/, ''), tags));
}

async function seedGroup(id) {
    await user.store.lib.writeGroup({ id, name: id, members: [], fav: false });
}

async function saveTags(ids) {
    for (const id of ids) await user.store.lib.tags.create({ id, name: `name-${id}` });
}

async function assign(id, tagId) {
    expect((await user.store.lib.tags.assign(id, tagId)).result).toBe('ok');
}

async function deleteTag(id, mergeInto) {
    const response = await post('/api/tags/delete', mergeInto === undefined ? { id } : { id, mergeInto });
    expect(response.status).toBe(200);
    return response.json();
}

async function listedTagIds() {
    return (await storedTagDefinitions(user.store.lib)).map(t => t.id).sort();
}

async function tagsFor(ids) {
    return (await post('/api/tags/for', { ids })).json();
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
    const result = await user.store.lib.query({ tags, sortField: 'name', limit: 100, wantRows: true, wantTotal: true });
    return { ids: result.rows.map(r => (r.type === 'group' ? r.item.id : r.item.avatar)).sort(), total: result.total };
}

describe('POST /api/tags/delete', () => {
    test('a delete answers what it did: no refusal, the tag merged into, and that tag\'s definition', async () => {
        await seedLibrary();
        expect(await deleteTag('x', 'y')).toMatchObject({ result: 'ok', refused: [], mergedInto: 'y', target: { id: 'y', name: 'name-y' } });
        expect(await deleteTag('d')).toEqual({ result: 'ok', refused: [], mergedInto: null, target: null });
    });

    test('an unknown merge target, the tag itself, or a target deleted with no merge: refused, nothing written', async () => {
        await seedLibrary();
        await deleteTag('d');
        const before = (await (await post('/api/tags/manifest')).json()).changesSeq;

        expect(await deleteTag('x', 'nope')).toEqual({ result: 'ok', refused: [{ id: 'nope', reason: 'missing' }], mergedInto: null, target: null });
        expect(await deleteTag('z', 'z')).toEqual({ result: 'ok', refused: [{ id: 'z', reason: 'same' }], mergedInto: null, target: null });
        expect(await deleteTag('x', 'd')).toEqual({ result: 'ok', refused: [{ id: 'd', reason: 'deleted' }], mergedInto: null, target: null });

        expect((await (await post('/api/tags/manifest')).json()).changesSeq).toBe(before);
        expect((await tagsFor(['c1.png', 'c2.png', 'g1']))).toEqual({ 'c1.png': ['x'], 'c2.png': ['x', 'y'], g1: ['x'] });
    });

    test('a deleted merge target is followed to its own target', async () => {
        await seedLibrary();
        await deleteTag('y', 'z');
        expect(await deleteTag('x', 'y')).toMatchObject({ refused: [], mergedInto: 'z', target: { id: 'z' } });
    });

    test('deleting a tag others merge into moves them onto its target', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        await deleteTag('y', 'z');
        expect((await tagsFor(['c1.png', 'c2.png', 'g1']))).toEqual({ 'c1.png': ['z'], 'c2.png': ['z'], g1: ['z'] });
    });

    test('a second delete keeps the first merge target', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        expect(await deleteTag('x', 'z')).toEqual({ result: 'ok', refused: [{ id: 'x', reason: 'deleted' }], mergedInto: null, target: null });
        expect(await tagsFor(['c1.png'])).toEqual({ 'c1.png': ['y'] });
    });

    test('deleting an id with no tag writes nothing', async () => {
        await seedLibrary();
        const before = (await (await post('/api/tags/manifest')).json()).changesSeq;
        expect(await deleteTag('ghost', 'y')).toEqual({ result: 'ok', refused: [{ id: 'ghost', reason: 'missing' }], mergedInto: null, target: null });
        expect((await (await post('/api/tags/manifest')).json()).changesSeq).toBe(before);
    });

    test('a non-string mergeInto is a 400', async () => {
        await seedLibrary();
        const response = await post('/api/tags/delete', { id: 'x', mergeInto: 5 });
        expect(response.status).toBe(400);
    });
});

describe('every tag definition read leaves a deleted tag out', () => {
    test('the stored definitions and /by-ids', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');

        expect(await listedTagIds()).toEqual(['d', 'y', 'z']);
        const byIds = (await (await post('/api/tags/by-ids', { ids: ['x', 'y'] })).json()).tags;
        expect(byIds.map(t => t.id)).toEqual(['y']);
    });
});

describe('entity tag lists read a deleted tag as its merge target', () => {
    test('/for: x reads as y, once where both are present; a tag with no target is gone', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        await deleteTag('d');
        expect(await tagsFor(['c1.png', 'c2.png', 'c3.png', 'c4.png', 'c5.png', 'g1', 'g2'])).toEqual({
            'c1.png': ['y'], 'c2.png': ['y'], 'c3.png': ['y'], 'c4.png': ['z'], 'c5.png': [], g1: ['y'], g2: ['z'],
        });
    });

    test('group hash rows carry the tag_ids digest of the resolved list', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        const groupHash = hashUtils.groupDigestTagIdsHash({ tag_ids: ['y'] });

        const entities = await user.store.lib.query({ sortField: 'name', limit: 100, wantRows: false, wantHashes: true });
        expect(entities.hashRows.find(r => r.id === 'g1').tagIdsHash).toBe(groupHash);

        const random = await user.store.lib.query({ sortField: 'random', seed: 3, limit: 100, wantRows: false, wantHashes: true });
        expect(random.hashRows.find(r => r.id === 'g1').tagIdsHash).toBe(groupHash);
    });

    test('a tag read answers a merged id with the live tag it reads as, chains followed', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        await deleteTag('y', 'z');
        await deleteTag('d');
        const answer = await (await post('/api/tags/by-ids', { ids: ['x', 'd'] })).json();
        expect(answer.merged).toEqual({ x: 'z' });
        expect(answer.gone).toEqual(['d']);
        // The target's definition comes with it, though it wasn't asked for; nothing nameless is a definition.
        expect(answer.tags.map(tag => tag.id)).toEqual(['z']);
        expect(answer.tags.every(tag => typeof tag.name === 'string')).toBe(true);
    });
});

describe('tag filters read a deleted tag as its merge target', () => {
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
        const result = await user.store.lib.query({ ids: ['c1.png', 'c4.png', 'g1'], tags: { include: ['y'] }, sortField: 'name', limit: 100 });
        expect(result.rows.map(r => (r.type === 'group' ? r.item.id : r.item.avatar)).sort()).toEqual(['c1.png', 'g1']);
        const andResult = await user.store.lib.query({ ids: ['c1.png', 'c2.png'], tags: { include: ['x', 'y'], mode: 'and' }, sortField: 'name', limit: 100, includeGroups: false });
        expect(andResult.rows.map(r => r.item.avatar).sort()).toEqual(['c1.png', 'c2.png']);
    });
});

describe('usage counts', () => {
    test('a count takes x\'s carriers into y, leaves x out, and lists y as approximate until they have moved', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        await deleteTag('d');
        let read;
        const deadline = Date.now() + 10_000;
        do {
            read = await tagCounts(user.store.lib, ['x', 'y', 'z', 'd']);
            expect(read.approximate.filter(id => id !== 'y')).toEqual([]);
        } while (read.approximate.length > 0 && Date.now() < deadline && await new Promise(resolve => setTimeout(resolve, 20, true)));
        const { counts, approximate } = read;
        expect(counts.x).toBeUndefined();
        expect(counts.d).toBeUndefined();
        // c1, c2 (which carried both), c3 and g1.
        expect(counts.y).toBe(4);
        expect(counts.z).toBe(2);
        expect(approximate).toEqual([]);
    });

    test('with nothing merging, the approximate list is empty', async () => {
        await seedLibrary();
        expect((await tagCounts(user.store.lib, ['x', 'y', 'z', 'd'])).approximate).toEqual([]);
    });

    test('unused-tag count and prune keep a target used only through x', async () => {
        await saveTags(['x', 'y', 'u']);
        await seedCharacter('c1.png');
        await assign('c1.png', 'x');
        await deleteTag('x', 'y');
        expect((await (await post('/api/tags/unused-count')).json()).count).toBe(1);
        const pruned = await (await post('/api/tags/prune', { limit: 10 })).json();
        expect(pruned.deleted).toEqual(['u']);
        expect(await listedTagIds()).toEqual(['y']);
    });
});

describe('writes that name a deleted tag', () => {
    test('/edit skips a deleted id', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        const edited = await post('/api/tags/edit', { id: 'x', patch: { name: 'renamed' } });
        expect(await edited.json()).toEqual({ result: 'ok', refused: [{ id: 'x', reason: 'deleted' }] });
        expect(await listedTagIds()).toEqual(['d', 'y', 'z']);
    });

    test('assign x writes y; assign of a tag with no target writes nothing', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        await deleteTag('d');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        await assign('c4.png', 'x');
        await assign('g2', 'x');
        await assign('c4.png', 'd');
        expect(await tagsFor(['c4.png', 'g2'])).toEqual({ 'c4.png': ['y', 'z'], g2: ['y', 'z'] });
    });

    test('unassigning x removes nothing and answers deleted: its carriers are y\'s, however far the merge has got', async () => {
        await seedLibrary();
        await deleteTag('x', 'y');
        expect(await user.store.lib.tags.unassign('c2.png', 'x')).toBe('deleted');
        const routed = await post('/api/tags/unassign', { id: 'c1.png', tagId: 'x' });
        expect(await routed.json()).toEqual({ result: 'ok', refused: [{ id: 'x', reason: 'deleted' }] });
        expect(await tagsFor(['c1.png', 'c2.png'])).toEqual({ 'c1.png': ['y'], 'c2.png': ['y'] });
    });

    test('a card tag named like x resolves to y', async () => {
        await saveTags(['x', 'y']);
        await deleteTag('x', 'y');
        await seedCharacter('card.png', ['name-x']);
        const seeded = await user.store.lib.tags.seedCardTags('card.png');
        expect(seeded.tagIds).toEqual(['y']);
        expect(seeded.tagDefinitions.map(t => t.id)).toEqual(['y']);
        expect(await tagsFor(['card.png'])).toEqual({ 'card.png': ['y'] });
    });

    test('a card tag named like a tag deleted with no target does not resolve to it', async () => {
        await saveTags(['d']);
        await deleteTag('d');
        await seedCharacter('card.png', ['name-d']);
        const seeded = await user.store.lib.tags.seedCardTags('card.png');
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
        expect((await storedTagDefinitions(user.store.lib)).map(({ id, name }) => ({ id, name }))).toEqual([{ id: 'a', name: 'name-a' }]);
    });

    test('create answers { result, refused }: empty when created, exists, deleted', async () => {
        await saveTags(['m']);
        await deleteTag('m');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const created = await post('/api/tags/create', { tag: { id: 'n', name: 'New' } });
        expect(created.status).toBe(200);
        expect(await created.json()).toEqual({ result: 'ok', refused: [], tag: { id: 'n', name: 'New', sort_order: 1 } });
        expect(await (await post('/api/tags/create', { tag: { id: 'n', name: 'Again' } })).json()).toEqual({ result: 'ok', refused: [{ id: 'n', reason: 'exists' }] });
        expect(await (await post('/api/tags/create', { tag: { id: 'm', name: 'Back' } })).json()).toEqual({ result: 'ok', refused: [{ id: 'm', reason: 'deleted' }] });
        expect((await storedTagDefinitions(user.store.lib)).find(t => t.id === 'n')).toEqual({ id: 'n', name: 'New', sort_order: 1 });
    });

    test('edit answers { result, refused }: empty when merged, missing, deleted', async () => {
        await saveTags(['a', 'm']);
        await deleteTag('m');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const edited = await post('/api/tags/edit', { id: 'a', patch: { id: 'a', color: 'red' } });
        expect(edited.status).toBe(200);
        expect(await edited.json()).toEqual({ result: 'ok', refused: [] });
        expect(await (await post('/api/tags/edit', { id: 'ghost', patch: { name: 'G' } })).json()).toEqual({ result: 'ok', refused: [{ id: 'ghost', reason: 'missing' }] });
        expect(await (await post('/api/tags/edit', { id: 'm', patch: { name: 'M' } })).json()).toEqual({ result: 'ok', refused: [{ id: 'm', reason: 'deleted' }] });
        expect((await storedTagDefinitions(user.store.lib)).find(t => t.id === 'a')).toMatchObject({ id: 'a', name: 'name-a', color: 'red' });
        expect((await storedTagDefinitions(user.store.lib)).find(t => t.id === 'ghost')).toBeUndefined();
    });
});
