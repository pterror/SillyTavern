import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';
import { storedTagDefinitions, storedTagUsageRows } from './tag-store-reads.js';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    fixture = await import('./converted-user.fixture.js');
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
    user = await fixture.emptyUser('st-tags-prune-test-');
    directories = user.directories;
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

async function post(urlPath, body = {}) {
    return fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function cardJson(name) {
    return JSON.stringify({
        name,
        data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } },
    });
}

async function seedCharacter(avatar) {
    await user.store.lib.writeCard(directories, avatar, cardJson(avatar.replace(/\.png$/, '')));
}

async function saveTags(ids) {
    for (const id of ids) await user.store.lib.tags.create({ id, name: id });
}

async function tagIds() {
    return (await storedTagDefinitions(user.store.lib)).map(t => t.id).sort();
}

async function unusedCount() {
    return (await (await post('/api/tags/unused-count')).json()).count;
}

describe('POST /api/tags/unused-count and /api/tags/prune', () => {
    test('prunes only tags no character or group uses', async () => {
        await seedCharacter('Alice.png');
        await user.store.lib.writeGroup({ id: 'group1', name: 'group1', members: [] });
        await saveTags(['onChar', 'onGroup', 'wasUsed', 'neverUsed']);
        await post('/api/tags/assign', { id: 'Alice.png', tagId: 'onChar' });
        await post('/api/tags/assign', { id: 'group1', tagId: 'onGroup' });
        await post('/api/tags/assign', { id: 'Alice.png', tagId: 'wasUsed' });
        await post('/api/tags/unassign', { id: 'Alice.png', tagId: 'wasUsed' });

        expect(await unusedCount()).toBe(2);

        const response = await post('/api/tags/prune', { limit: 500 });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.deleted.sort()).toEqual(['neverUsed', 'wasUsed']);
        expect(body.more).toBe(false);

        expect(await tagIds()).toEqual(['onChar', 'onGroup']);
        expect(await unusedCount()).toBe(0);
    });

    test('removes each pruned tag and keeps the others', async () => {
        await seedCharacter('Alice.png');
        await saveTags(['onChar', 'wasUsed']);
        await post('/api/tags/assign', { id: 'Alice.png', tagId: 'onChar' });
        await post('/api/tags/assign', { id: 'Alice.png', tagId: 'wasUsed' });
        await post('/api/tags/unassign', { id: 'Alice.png', tagId: 'wasUsed' });

        const usage = () => storedTagUsageRows(user.store.lib);
        expect(await usage()).toEqual({ onChar: 1, wasUsed: 0 });

        const body = await (await post('/api/tags/prune', { limit: 500 })).json();
        expect(body.deleted).toEqual(['wasUsed']);
        expect(await usage()).toEqual({ onChar: 1 });
    });

    test('keeps a tag carried only by a character written in a batch of imports', async () => {
        await saveTags(['pendingTag']);
        user.store.lib.beginBatch();
        try {
            await user.store.lib.writeCard(directories, 'Bob.png', cardJson('Bob'));
            expect((await user.store.lib.tags.assign('Bob.png', 'pendingTag')).result).toBe('ok');

            expect(await unusedCount()).toBe(0);
            expect((await (await post('/api/tags/prune', { limit: 500 })).json()).deleted).toEqual([]);
            expect(await tagIds()).toEqual(['pendingTag']);
        } finally {
            user.store.lib.endBatch();
        }
    });

    test('deletes at most `limit` per call and reports whether more remain', async () => {
        await saveTags(['a', 'b', 'c']);

        const first = await (await post('/api/tags/prune', { limit: 2 })).json();
        expect(first.deleted).toHaveLength(2);
        expect(first.more).toBe(true);

        const second = await (await post('/api/tags/prune', { limit: 2 })).json();
        expect(second.deleted).toHaveLength(1);
        expect(second.more).toBe(false);

        expect(await tagIds()).toEqual([]);
    });

    test('400s on a missing or out-of-range limit', async () => {
        for (const body of [{}, { limit: 0 }, { limit: 501 }, { limit: 1.5 }, { limit: 'x' }]) {
            expect((await post('/api/tags/prune', body)).status).toBe(400);
        }
    });
});
