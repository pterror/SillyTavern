import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/metadata-migration-coordinator.js')} */
let coordinatorModule;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-delete-on-demand-test-'));
    directories = /** @type {any} */ ({
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    coordinatorModule = await import('../src/metadata-migration-coordinator.js');
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

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await coordinatorModule.disposeMetadataMigrationWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(tempDir, { recursive: true, force: true });
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

describe('POST /api/tags/delete while the server is running', () => {
    test('asks for the finishing pass, which finishes the delete and clears the approximate flag with no restart', async () => {
        // The store's boot chain has finished, and no boot migration run was ever started.
        await Promise.all(await metadataDb.initializeMetadataStores([directories]));
        await metadataDb.saveTagDefinitions(directories, [{ id: 'x', name: 'name-x' }, { id: 'y', name: 'name-y' }]);
        for (const avatar of ['c1.png', 'c2.png']) {
            await metadataDb.upsertCharacterFromWrite(directories, avatar, cardJson(avatar.replace(/\.png$/, '')));
        }
        expect(await metadataDb.assignEntityTag(directories, 'c1.png', 'x')).toBe('ok');
        expect(await metadataDb.assignEntityTag(directories, 'c2.png', 'x')).toBe('ok');
        expect(await metadataDb.assignEntityTag(directories, 'c2.png', 'y')).toBe('ok');

        const response = await post('/api/tags/delete', { id: 'x', mergeInto: 'y' });
        expect(response.status).toBe(200);

        await coordinatorModule.whenMetadataMigrationsIdle(directories);

        expect(await metadataDb.getAllTagUsage(directories)).toEqual({ counts: { y: 2 }, approximate: [] });
        const { tags } = await (await post('/api/tags/get')).json();
        expect(tags.map(t => t.id)).toEqual(['y']);
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(path.join(tempDir, 'character-metadata.sqlite'), { readonly: true });
        try {
            expect(db.prepare('SELECT COUNT(*) AS n FROM tag_deletions').get()).toEqual({ n: 0 });
            expect(Array.from(db.prepare('SELECT character_id, tag_id FROM character_tags ORDER BY character_id').iterate()))
                .toEqual([{ character_id: 'c1.png', tag_id: 'y' }, { character_id: 'c2.png', tag_id: 'y' }]);
        } finally {
            db.close();
        }
    });
});
