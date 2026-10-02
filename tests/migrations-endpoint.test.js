import { describe, test, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/migrations/migration-notices.js')} */
let notices;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

const NOTICE_ID = 'unimport-embedded-lore';

/**
 * Mounts the real migrations router behind a fake auth middleware that stamps a per-user `directories` object
 * pointing at a throwaway temp directory, mirroring how the real app's user middleware populates `request.user`.
 */
beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-migrations-endpoint-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        worlds: path.join(tempDir, 'worlds'),
        groups: path.join(tempDir, 'groups'),
    };
    for (const dir of [directories.characters, directories.chats, directories.worlds, directories.groups]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    notices = await import('../src/migrations/migration-notices.js');
    const { router } = await import('../src/endpoints/migrations.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: 'test-user' } };
        next();
    });
    app.use('/api/migrations', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    metadataDb.disposeMetadataStores();
});

beforeEach(async () => {
    await notices.replaceNotice(directories, NOTICE_ID, new notices.NoticeCollector());
});

async function postJson(urlPath, body) {
    return fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function makeCard(avatar, overrides = {}) {
    const name = avatar.replace(/\.png$/, '');
    return {
        name,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '',
            extensions: { fav: false, world: '' },
        },
        ...overrides,
    };
}

describe('/api/migrations', () => {
    test('lists nothing when no notice is stored', async () => {
        const response = await postJson('/api/migrations/notices', {});
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ notices: [] });
    });

    test('lists a stored notice with the listed characters\' names', async () => {
        const card = makeCard('Named.png', { name: 'Named Person', data: { ...makeCard('Named.png').data, name: 'Named Person' } });
        await metadataDb.upsertCharacterFromWrite(directories, 'Named.png', JSON.stringify(card), null, null);
        const collector = new notices.NoticeCollector();
        collector.addSkipped({ avatar: 'Named.png', world: 'Lost', reason: 'world-unreadable' });
        collector.addFailing({ avatar: 'Gone.png', world: 'W' });
        await notices.replaceNotice(directories, NOTICE_ID, collector);
        const { version } = await notices.readNotice(directories, NOTICE_ID);

        const response = await postJson('/api/migrations/notices', {});
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            notices: [{
                id: 'unimport-embedded-lore',
                version,
                skipped: { total: 1, entries: [{ avatar: 'Named.png', world: 'Lost', reason: 'world-unreadable', name: 'Named Person' }] },
                failing: { total: 1, entries: [{ avatar: 'Gone.png', world: 'W', name: null }] },
                noWorld: { total: 0, entries: [] },
                hasReport: false,
            }],
        });
    });

    test('serves the full report once a pass wrote it, and nothing for an unknown id', async () => {
        expect((await fetch(`${baseUrl}/api/migrations/report/unimport-embedded-lore`)).status).toBe(404);
        const report = new (await import('../src/migrations/migration-report.js')).MigrationReport(directories, NOTICE_ID, 'heading');
        report.add('left as it was: A.png');
        await report.close();
        const response = await fetch(`${baseUrl}/api/migrations/report/unimport-embedded-lore`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('heading\n\nleft as it was: A.png\n');
        expect((await fetch(`${baseUrl}/api/migrations/report/other`)).status).toBe(404);
    });

    test('marks a notice seen only for its current version', async () => {
        const collector = new notices.NoticeCollector();
        collector.addSkipped({ avatar: 'Ghost.png', world: 'Missing Lore', reason: 'world-unreadable' });
        await notices.replaceNotice(directories, NOTICE_ID, collector);
        const { version } = await notices.readNotice(directories, NOTICE_ID);

        const stale = await postJson('/api/migrations/notices/seen', { id: NOTICE_ID, version: version - 1 });
        expect(stale.status).toBe(200);
        expect(await stale.json()).toEqual({ cleared: false });
        const stillListed = await (await postJson('/api/migrations/notices', {})).json();
        expect(stillListed.notices).toHaveLength(1);
        expect(stillListed.notices[0].version).toBe(version);

        const current = await postJson('/api/migrations/notices/seen', { id: NOTICE_ID, version });
        expect(current.status).toBe(200);
        expect(await current.json()).toEqual({ cleared: true });
        expect(await (await postJson('/api/migrations/notices', {})).json()).toEqual({ notices: [] });
    });

    test('rejects a malformed seen request', async () => {
        for (const body of [{}, { id: 'other', version: 1 }, { id: 'unimport-embedded-lore', version: '1' }]) {
            const response = await postJson('/api/migrations/notices/seen', body);
            expect(response.status).toBe(400);
        }
    });
});
