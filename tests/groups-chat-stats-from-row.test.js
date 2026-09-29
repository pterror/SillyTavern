import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {typeof import('../src/endpoints/groups.js')} */
let groupsModule;
/** @type {typeof import('../src/endpoints/groups-search-index.js')} */
let groupsSearchIndex;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;
let handle;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    groupsModule = await import('../src/endpoints/groups.js');
    groupsSearchIndex = await import('../src/endpoints/groups-search-index.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle } };
        next();
    });
    app.use('/api/groups', groupsModule.router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-groups-chat-stats-from-row-test-'));
    directories = /** @type {any} */ ({
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    });
    // Search index workers are keyed by handle, so each test's fresh directories get their own handle.
    handle = `test-user-${path.basename(tempDir)}`;
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(async () => {
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/**
 * @param {string} id
 * @param {string} name
 * @param {string} chatId
 * @param {number} chatBytes
 */
function writeGroupWithChatFile(id, name, chatId, chatBytes) {
    const group = { id, name, members: [], chats: [chatId], chat_id: chatId };
    fs.writeFileSync(path.join(directories.groupChats, `${chatId}.jsonl`), 'x'.repeat(chatBytes));
    return { group, writeFile: () => fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group)) };
}

describe('getGroupsData takes chat_size and date_last_chat from the group rows, not the group chat files', () => {
    test('/groups/all and the groups search index', async () => {
        const withRow = writeGroupWithChatFile('g1', 'Quuxbrook', 'c1', 4321);
        await metadataDb.writeGroupFileAndRow(directories, withRow.group, withRow.writeFile);
        await metadataDb.applyGroupChatStats(directories, 'g1', { sizeChange: 1234, addedCreatedAt: 5678, readLastCreatedAt: null });

        const withoutRow = writeGroupWithChatFile('g2', 'Quuxfield', 'c2', 999);
        withoutRow.writeFile();

        const expected = [['g1', 1234, 5678], ['g2', 0, 0]];
        /** @param {any[]} groups */
        const stats = groups => ['g1', 'g2'].map(id => {
            const group = groups.find(g => g.id === id);
            return [id, group?.chat_size, group?.date_last_chat];
        });

        expect(stats(await groupsModule.getGroupsData(directories))).toEqual(expected);

        const all = await (await fetch(`${baseUrl}/api/groups/all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
        expect(stats(all)).toEqual(expected);

        const { results, backend } = await groupsSearchIndex.searchGroups(handle, directories, 'quux', 10, false);
        expect(backend).toBe('tantivy');
        expect(stats(results.map(r => r.item))).toEqual(expected);
    }, 30000);
});
