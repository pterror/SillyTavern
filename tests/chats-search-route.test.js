import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import path from 'node:path';

import express from 'express';

import { setConfigFilePath } from '../src/util.js';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').convertedUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let base = '';
const SESSION = '0190a1b2-0000-7000-8000-00000000c0de';

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    fixture = await import('./converted-user.fixture.js');
    user = await fixture.convertedUser('chats-search-');
    const { router } = await import('../src/endpoints/chats.js');
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/chats', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await user.close();
});

/**
 * @param {string} url
 * @param {object} body
 */
async function post(url, body) {
    const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ST-Session': SESSION }, body: JSON.stringify({ avatar_url: 'Bob.png', ...body }) });
    return { status: res.status, data: await res.json() };
}

const msg = (/** @type {string} */ mes) => ({ name: 'Bob', is_user: false, is_system: false, mes, extra: {} });

const labels = (/** @type {any[]} */ rows) => rows.map(r => r.label);

describe('POST /api/chats/search', () => {
    test('finds a chat by a part of a word in its messages: paged with scan_cursor, and the whole list for upstream\'s callers', async () => {
        const [, second] = await fixture.seedMessages(user.store, { avatar: 'Bob.png' }, null, ['first', 'wandering about'].map(msg), { session: SESSION });
        const tree = await fixture.treeOf(user.store, { avatar: 'Bob.png' });
        await user.store.chats.createBookmark({ tree, node_id: second, name: 'The walk', mode: 2, actor: { user: 'u', session: SESSION } });

        const paged = await post('/api/chats/search', { query: 'WANDE', limit: 50 });
        expect(paged.status).toBe(200);
        expect(labels(paged.data.results)).toEqual([null, 'The walk']);
        expect(paged.data.cursor).toBeNull();
        expect(paged.data.scan_cursor).toBeNull();
        expect(paged.data.exact).toBe(true);

        const whole = await post('/api/chats/search', { query: 'wandering', limit: 50 });
        expect(labels(whole.data.results)).toEqual([null, 'The walk']);

        const all = await post('/api/chats/search', { query: 'wande' });
        expect(labels(all.data)).toEqual([null, 'The walk']);
        expect((await post('/api/chats/search', { query: 'nothing here' })).data).toEqual([]);

        expect((await post('/api/chats/search', { query: 'wande', limit: 50, scan_cursor: 'x' })).data.results).toHaveLength(2);
    });
});
