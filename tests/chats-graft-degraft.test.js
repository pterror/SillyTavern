import { beforeAll, afterAll, beforeEach, describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// chats.js reads these config values at module load (see chat-integrity.test.js's own comment on this) -
// environment variables let the module import without a config file present, and the throttle interval is
// zeroed so lodash throttle timers don't keep the Jest process alive.
process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'false';
process.env.SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS = '-1';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';
process.env.SILLYTAVERN_BACKUPS_CHAT_CHECKINTEGRITY = 'true';
process.env.SILLYTAVERN_PERFORMANCE_SHALLOWCHARACTERSINCLUDECREATORNOTES = 'false';
process.env.SILLYTAVERN_PERFORMANCE_CHARACTERINDEXBUILDCONCURRENCY = '4';
process.env.SILLYTAVERN_PERFORMANCE_CHARACTERMETADATARECONCILEINTERVALMS = '300000';
process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'true';

/** @type {typeof import('../src/endpoints/chats.js')} */
let chats;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/** Mounts the real chats.js router behind a fake auth middleware, mirroring worldinfo-endpoint.test.js's convention. */
beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    chats = await import('../src/endpoints/chats.js');

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chats-graft-test-'));
    directories = { root: tempDir, characters: path.join(tempDir, 'characters'), chats: path.join(tempDir, 'chats') };
    fs.mkdirSync(directories.characters, { recursive: true });
    fs.mkdirSync(directories.chats, { recursive: true });

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: 'test-user' } };
        next();
    });
    app.use('/api/chats', chats.router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

async function postJson(urlPath, body) {
    const res = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** A minimal message-object body the tree store round-trips. */
function makeMessage(mes) {
    return { name: 'Char', is_user: false, mes, extra: {} };
}

/** Seeds a fresh owner with a 3-message chain via /save, returning that chat's node ids in order. */
async function seedChain(ownerAvatar) {
    const chatData = [
        { chat_metadata: {} },
        makeMessage('m0'),
        makeMessage('m1'),
        makeMessage('m2'),
    ];
    await postJson('/api/chats/save', { avatar_url: ownerAvatar, ch_name: ownerAvatar, file_name: 'chat', chat: chatData, force: true });
    const res = await postJson('/api/chats/get', { avatar_url: ownerAvatar, ch_name: ownerAvatar, file_name: 'chat' });
    const messages = res.body.filter(m => m.mes !== undefined);
    return messages.map(m => m.node_id);
}

describe('POST /api/chats/message/graft', () => {
    let counter = 0;
    function nextAvatar() {
        counter += 1;
        return `graft-owner-${counter}.png`;
    }

    test('inserts a node between two adjacent nodes and returns its id', async () => {
        const avatar = nextAvatar();
        const [n0, n1] = await seedChain(avatar);

        const res = await postJson('/api/chats/message/graft', {
            avatar_url: avatar, after_node_id: n0, before_node_id: n1, content: makeMessage('grafted'),
        });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(typeof res.body.node_id).toBe('string');
        expect(res.body.node_id).not.toBe(n0);
        expect(res.body.node_id).not.toBe(n1);
    });

    test('400s when after_node_id is missing', async () => {
        const avatar = nextAvatar();
        const [, n1] = await seedChain(avatar);
        const res = await postJson('/api/chats/message/graft', { avatar_url: avatar, before_node_id: n1, content: makeMessage('x') });
        expect(res.status).toBe(400);
    });

    test('400s when before_node_id is missing', async () => {
        const avatar = nextAvatar();
        const [n0] = await seedChain(avatar);
        const res = await postJson('/api/chats/message/graft', { avatar_url: avatar, after_node_id: n0, content: makeMessage('x') });
        expect(res.status).toBe(400);
    });

    test('409s and refuses when before_node_id is not adjacent to after_node_id', async () => {
        const avatar = nextAvatar();
        const [n0, , n2] = await seedChain(avatar);
        const res = await postJson('/api/chats/message/graft', {
            avatar_url: avatar, after_node_id: n0, before_node_id: n2, content: makeMessage('x'),
        });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ ok: false, reason: 'not adjacent' });
    });
});

describe('POST /api/chats/message/degraft', () => {
    let counter = 0;
    function nextAvatar() {
        counter += 1;
        return `degraft-owner-${counter}.png`;
    }

    test('removes a single mid-chain message from the default path', async () => {
        const avatar = nextAvatar();
        const [, n1, n2] = await seedChain(avatar);

        const res = await postJson('/api/chats/message/degraft', {
            avatar_url: avatar, first_node_id: n1, last_node_id: n1,
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });

        const loaded = await postJson('/api/chats/get', { avatar_url: avatar, ch_name: avatar, file_name: 'chat' });
        const mesList = loaded.body.filter(m => m.mes !== undefined).map(m => m.mes);
        expect(mesList).toEqual(['m0', 'm2']);
    });

    test('accepts first_node_id === last_node_id implicitly via a default last_node_id', async () => {
        const avatar = nextAvatar();
        const [, n1] = await seedChain(avatar);
        const res = await postJson('/api/chats/message/degraft', { avatar_url: avatar, first_node_id: n1 });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    test('400s when first_node_id is missing', async () => {
        const avatar = nextAvatar();
        await seedChain(avatar);
        const res = await postJson('/api/chats/message/degraft', { avatar_url: avatar });
        expect(res.status).toBe(400);
    });

    test('409s and refuses a node that is not on the default path', async () => {
        const avatar = nextAvatar();
        const [, n1] = await seedChain(avatar);

        // Add a sibling alternative to n1 that never becomes the default child.
        const altRes = await postJson('/api/chats/message/alternative', {
            avatar_url: avatar, sibling_node_id: n1, contents: [makeMessage('alt-m1')],
        });
        const altId = altRes.body.node_ids[0];

        const res = await postJson('/api/chats/message/degraft', {
            avatar_url: avatar, first_node_id: altId, last_node_id: altId,
        });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ ok: false, reason: 'not on default path' });
    });

    test('409s and refuses a tail node (nothing follows it) instead of silently doing the wrong thing', async () => {
        const avatar = nextAvatar();
        const [, , n2] = await seedChain(avatar);
        const res = await postJson('/api/chats/message/degraft', { avatar_url: avatar, first_node_id: n2, last_node_id: n2 });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ ok: false, reason: 'use end-path instead' });
    });
});

describe('POST /api/chats/message/swap-adjacent', () => {
    let counter = 0;
    function nextAvatar() {
        counter += 1;
        return `swap-owner-${counter}.png`;
    }

    test('swaps two adjacent messages and persists the new order', async () => {
        const avatar = nextAvatar();
        const [, n1, n2] = await seedChain(avatar);

        const res = await postJson('/api/chats/message/swap-adjacent', {
            avatar_url: avatar, upper_node_id: n1, lower_node_id: n2,
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });

        const loaded = await postJson('/api/chats/get', { avatar_url: avatar, ch_name: avatar, file_name: 'chat' });
        const messages = loaded.body.filter(m => m.mes !== undefined);
        expect(messages.map(m => m.mes)).toEqual(['m0', 'm2', 'm1']);
        expect(messages.map(m => m.node_id)).toEqual([messages[0].node_id, n2, n1]);
    });

    test('400s when upper_node_id is missing', async () => {
        const avatar = nextAvatar();
        const [, , n2] = await seedChain(avatar);
        const res = await postJson('/api/chats/message/swap-adjacent', { avatar_url: avatar, lower_node_id: n2 });
        expect(res.status).toBe(400);
    });

    test('400s when lower_node_id is missing', async () => {
        const avatar = nextAvatar();
        const [, n1] = await seedChain(avatar);
        const res = await postJson('/api/chats/message/swap-adjacent', { avatar_url: avatar, upper_node_id: n1 });
        expect(res.status).toBe(400);
    });

    test('409s and refuses non-adjacent nodes', async () => {
        const avatar = nextAvatar();
        const [n0, , n2] = await seedChain(avatar);
        const res = await postJson('/api/chats/message/swap-adjacent', {
            avatar_url: avatar, upper_node_id: n0, lower_node_id: n2,
        });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ ok: false, reason: 'not adjacent' });
    });

    test('409s and refuses when the upper node is not on the default path', async () => {
        const avatar = nextAvatar();
        const [, n1, n2] = await seedChain(avatar);

        // Add a sibling alternative to n1 that never becomes the default child.
        const altRes = await postJson('/api/chats/message/alternative', {
            avatar_url: avatar, sibling_node_id: n1, contents: [makeMessage('alt-m1')],
        });
        const altId = altRes.body.node_ids[0];

        const res = await postJson('/api/chats/message/swap-adjacent', {
            avatar_url: avatar, upper_node_id: altId, lower_node_id: n2,
        });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ ok: false, reason: 'not adjacent' });
    });

    test('swap at the very end of the chain (lower node has no child) does not crash', async () => {
        const avatar = nextAvatar();
        const [, n1, n2] = await seedChain(avatar);

        const res = await postJson('/api/chats/message/swap-adjacent', {
            avatar_url: avatar, upper_node_id: n1, lower_node_id: n2,
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });

        const loaded = await postJson('/api/chats/get', { avatar_url: avatar, ch_name: avatar, file_name: 'chat' });
        const messages = loaded.body.filter(m => m.mes !== undefined);
        expect(messages.map(m => m.mes)).toEqual(['m0', 'm2', 'm1']);
    });

    test('swapping twice in a row returns to the original order', async () => {
        const avatar = nextAvatar();
        const [n0, n1, n2] = await seedChain(avatar);

        const first = await postJson('/api/chats/message/swap-adjacent', {
            avatar_url: avatar, upper_node_id: n1, lower_node_id: n2,
        });
        expect(first.body).toEqual({ ok: true });

        const second = await postJson('/api/chats/message/swap-adjacent', {
            avatar_url: avatar, upper_node_id: n2, lower_node_id: n1,
        });
        expect(second.body).toEqual({ ok: true });

        const loaded = await postJson('/api/chats/get', { avatar_url: avatar, ch_name: avatar, file_name: 'chat' });
        const messages = loaded.body.filter(m => m.mes !== undefined);
        expect(messages.map(m => m.mes)).toEqual(['m0', 'm1', 'm2']);
        expect(messages.map(m => m.node_id)).toEqual([n0, n1, n2]);
    });
});
