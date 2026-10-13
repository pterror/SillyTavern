import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import path from 'node:path';

import express from 'express';

import { setConfigFilePath } from '../src/util.js';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').convertedUser>>} */
let user;
/** @type {import('node:http').Server} */
let server;
let base = '';
const GROUP = '1700000000001';

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    user = await (await import('./converted-user.fixture.js')).convertedUser('groups-delete-');
    const { router } = await import('../src/endpoints/groups.js');
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/groups', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await user.close();
});

describe('POST /api/groups/delete', () => {
    test('without delete_chats (as upstream\'s page sends it) deletes the group\'s tree too, listing what went', async () => {
        const { TYPE } = await import('../src/library-codes.js');
        const lib = user.store.lib;
        const [tree] = await lib.ids(TYPE.group, [GROUP]);
        expect(tree).not.toBeNull();
        expect(await lib.holdsChats(/** @type {bigint} */ (tree))).toBe(true);

        const res = await fetch(`${base}/api/groups/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: GROUP }) });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.dropped.bookmarks.length).toBeGreaterThan(0);

        expect(await lib.ids(TYPE.group, [GROUP])).toEqual([null]);
        expect(await lib.ids(TYPE.tree, [GROUP])).toEqual([null]);
        expect(await lib.holdsChats(/** @type {bigint} */ (tree))).toBe(false);
    });
});
