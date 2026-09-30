import { describe, test, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-prune-test-'));
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

function cardJson(name) {
    return JSON.stringify({
        name,
        data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } },
    });
}

async function seedCharacter(avatar) {
    await metadataDb.upsertCharacterFromWrite(directories, avatar, cardJson(avatar.replace(/\.png$/, '')));
}

async function saveTags(ids) {
    await metadataDb.saveTagDefinitions(directories, ids.map(id => ({ id, name: id })));
}

async function tagIds() {
    const { tags } = await (await post('/api/tags/get')).json();
    return tags.map(t => t.id).sort();
}

async function unusedCount() {
    return (await (await post('/api/tags/unused-count')).json()).count;
}

describe('POST /api/tags/unused-count and /api/tags/prune', () => {
    test('prunes only tags no character or group uses', async () => {
        await seedCharacter('Alice.png');
        await metadataDb.upsertGroupRow(directories, 'group1', 'group1');
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

    test('removes each pruned tag\'s zero-count tag_usage row and keeps the others', async () => {
        await seedCharacter('Alice.png');
        await saveTags(['onChar', 'wasUsed']);
        await post('/api/tags/assign', { id: 'Alice.png', tagId: 'onChar' });
        await post('/api/tags/assign', { id: 'Alice.png', tagId: 'wasUsed' });
        await post('/api/tags/unassign', { id: 'Alice.png', tagId: 'wasUsed' });

        const usage = async () => (await fetch(`${baseUrl}/api/tags/usage`)).json();
        expect(await usage()).toEqual({ onChar: 1, wasUsed: 0 });

        const body = await (await post('/api/tags/prune', { limit: 500 })).json();
        expect(body.deleted).toEqual(['wasUsed']);
        expect(await usage()).toEqual({ onChar: 1 });
    });

    test('keeps a tag carried only by a batch-import row not yet flushed', async () => {
        await saveTags(['pendingTag']);
        await metadataDb.beginBatchImport(directories);
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson('Bob'), null, null, { fromImport: true });
        expect(await metadataDb.assignEntityTag(directories, 'Bob.png', 'pendingTag')).toBe('ok');

        expect(await unusedCount()).toBe(0);
        expect((await (await post('/api/tags/prune', { limit: 500 })).json()).deleted).toEqual([]);
        expect(await tagIds()).toEqual(['pendingTag']);

        await metadataDb.endBatchImport(directories);
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
