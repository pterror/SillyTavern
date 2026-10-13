import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/endpoints/groups.js')} */
let groupsModule;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    fixture = await import('./converted-user.fixture.js');
    groupsModule = await import('../src/endpoints/groups.js');
    const { router: charactersRouter } = await import('../src/endpoints/characters.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/groups', groupsModule.router);
    app.use('/api/characters', charactersRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
});

beforeEach(async () => {
    user = await fixture.emptyUser('st-groups-chat-stats-from-row-test-');
    ({ directories } = user);
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

/**
 * A group with a chat file in the group chats folder (which nothing reads).
 * @param {string} id
 * @param {string} name
 * @param {string} chatId
 * @param {number} chatBytes
 */
async function writeGroupWithChatFile(id, name, chatId, chatBytes) {
    fs.writeFileSync(path.join(directories.groupChats, `${chatId}.jsonl`), 'x'.repeat(chatBytes));
    await user.store.lib.writeGroup({ id, name, members: [] });
}

describe('the group routes take chat_size and date_last_chat from the group\'s chats, not the group chat files', () => {
    test('/groups/all and the groups search', async () => {
        await writeGroupWithChatFile('g1', 'Quuxbrook', 'c1', 4321);
        // The group's chat messages are what the stats come from.
        await fixture.saveBranch(user.store, { group: 'g1' }, 'c1', [{}, { name: 'User', is_user: true, mes: 'hello there', send_date: 5678, extra: {} }]);
        const tree = await fixture.treeOf(user.store, { group: 'g1' });
        const real = (await user.store.lib.chatStats([tree])).get(tree);
        expect(real?.chat_size).toBeGreaterThan(0);
        expect(real?.chat_size).not.toBe(4321);

        await writeGroupWithChatFile('g2', 'Quuxfield', 'c2', 999);

        const expected = [['g1', real?.chat_size, real?.date_last_chat], ['g2', 0, 0]];
        /** @param {any[]} groups */
        const stats = groups => ['g1', 'g2'].map(id => {
            const group = groups.find(g => g.id === id);
            return [id, group?.chat_size, group?.date_last_chat];
        });

        const all = await (await fetch(`${baseUrl}/api/groups/all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
        expect(stats(all)).toEqual(expected);

        const searched = await (await fetch(`${baseUrl}/api/characters/query`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filter: { includeGroups: true, group: true, search: 'quux' }, want: ['rows'], pageSize: 10 }),
        })).json();
        expect(stats(searched.rows.map(r => r.item))).toEqual(expected);
    }, 30000);
});
