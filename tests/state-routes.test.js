import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import path from 'node:path';

import express from 'express';

import { setConfigFilePath } from '../src/util.js';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').convertedUser>>} */
let user;
/** @type {import('node:http').Server} */
let server;
let base = '';

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    user = await (await import('./converted-user.fixture.js')).convertedUser('state-routes-');
    const root = user.root;
    const { router } = await import('../src/endpoints/state.js');
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
        req.user = { directories: { root }, profile: { handle: 'u' } };
        next();
    });
    app.use('/api/state', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await user.close();
});

/** @param {string} url @param {object} body @param {Record<string, string>} [headers] */
async function post(url, body, headers = {}) {
    const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, headers: res.headers, data: await res.json() };
}

/** @param {{ data: { state: Record<string, unknown> } }} r */
const stateOf = r => {
    const { integrity, ...rest } = r.data.state;
    expect(typeof integrity).toBe('string');
    return rest;
};

describe('/api/state', () => {
    test('a change at the root is read there, reverted, and its revert reverted; a read with the page\'s hash answers unchanged', async () => {
        const owner = { avatar_url: 'Alice.png' };
        expect(stateOf(await post('/api/state/at', { ...owner, at: null }))).toEqual({});
        const changed = await post('/api/state/change', { ...owner, at: null, ops: [{ key: 'note_prompt', value: 'Hi.' }, { key: 'hp', variable: true, value: 5 }], ref: 'test' });
        expect(changed.status).toBe(200);
        expect(changed.data.changes.length).toBe(2);
        const read = await post('/api/state/at', { ...owner, at: null });
        expect(stateOf(read)).toEqual({ note_prompt: 'Hi.', variables: { hp: 5 } });
        expect((await post('/api/state/at', { ...owner, at: null, if_hash: read.data.hash })).data).toEqual({ unchanged: true });
        const reverted = await post('/api/state/revert', { change: changed.data.changes[0] });
        expect(reverted.status).toBe(200);
        expect(stateOf(await post('/api/state/at', { ...owner, at: null }))).toEqual({ variables: { hp: 5 } });
        expect((await post('/api/state/revert', { change: reverted.data.change })).status).toBe(200);
        expect(stateOf(await post('/api/state/at', { ...owner, at: null }))).toEqual({ note_prompt: 'Hi.', variables: { hp: 5 } });
        // Writing what is there records nothing.
        expect((await post('/api/state/change', { ...owner, at: null, ops: [{ key: 'note_prompt', value: 'Hi.' }] })).data.changes).toEqual([]);
    });

    test('a tab\'s own session reads its integrity; unknown owners, nodes and changes are refused', async () => {
        const session = '0190a1b2-0000-7000-8000-0000000000ee';
        const read = await post('/api/state/at', { avatar_url: 'Bob.png', at: null }, { 'X-ST-Session': session });
        expect(read.status).toBe(200);
        expect(read.data.state.integrity).toBe(session);
        expect(read.headers.get('X-ST-Session-Moved')).toBeNull();
        expect((await post('/api/state/at', { avatar_url: 'Nobody.png', at: null })).status).toBe(404);
        expect((await post('/api/state/change', { avatar_url: 'Bob.png', at: 'no-such-node', ops: [] })).status).toBe(404);
        expect((await post('/api/state/change', { avatar_url: 'Bob.png', at: null, ops: 'x' })).status).toBe(400);
        expect((await post('/api/state/revert', { change: '999999' })).status).toBe(404);
    });
});
