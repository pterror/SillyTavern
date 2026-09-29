import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// chats.js reads these config values at module load (see chats-graft-degraft.test.js).
process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'false';
process.env.SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS = '-1';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';
process.env.SILLYTAVERN_BACKUPS_CHAT_CHECKINTEGRITY = 'true';
process.env.SILLYTAVERN_PERFORMANCE_SHALLOWCHARACTERSINCLUDECREATORNOTES = 'false';
process.env.SILLYTAVERN_PERFORMANCE_CHARACTERINDEXBUILDCONCURRENCY = '4';
process.env.SILLYTAVERN_PERFORMANCE_CHARACTERMETADATARECONCILEINTERVALMS = '300000';
process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'true';

/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    const chats = await import('../src/endpoints/chats.js');

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-openings-land-test-'));
    const directories = { root: tempDir, characters: path.join(tempDir, 'characters'), chats: path.join(tempDir, 'chats') };
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

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
});

async function postJson(urlPath, body) {
    const res = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

let counter = 0;

/**
 * A character with no card on disk whose stored openings are `texts`, in order. Resolves to its avatar and their row ids.
 * @param {string[]} texts
 */
async function ownerWithOpenings(texts) {
    counter += 1;
    const avatar = `land-owner-${counter}.png`;
    const contents = texts.map(mes => ({ name: 'Char', is_user: false, is_system: false, send_date: 'd0', mes, extra: {} }));
    const res = await postJson('/api/chats/openings/ensure', { avatar_url: avatar, contents });
    expect(res.status).toBe(200);
    return { avatar, ids: res.body.node_ids };
}

const openings = n => Array.from({ length: n }, (_, i) => `opening ${i}`);

describe('POST /api/chats/openings/land', () => {
    test('rule 1: the opening with exactly the shown text, even outside a first window of 11', async () => {
        const texts = openings(20);
        const { avatar, ids } = await ownerWithOpenings(texts);
        const res = await postJson('/api/chats/openings/land', { avatar_url: avatar, shown_text: texts[17], index: 2 });
        expect(res.status).toBe(200);
        expect(res.body.index).toBe(17);
        expect(res.body.opening).toMatchObject({ node_id: ids[17], mes: texts[17] });
    });

    test('rule 2: this page\'s own edit from the shown text leads to the opening with its new text', async () => {
        const texts = openings(15);
        const { avatar, ids } = await ownerWithOpenings(texts);
        const res = await postJson('/api/chats/openings/land', {
            avatar_url: avatar, shown_text: 'was edited', index: 1,
            edits: [{ from: 'other', to: texts[3] }, { from: 'was edited', to: texts[13] }],
        });
        expect(res.body.index).toBe(13);
        expect(res.body.opening.node_id).toBe(ids[13]);
    });

    test('rule 3: a shown text no opening has lands at the same index', async () => {
        const texts = openings(15);
        const { avatar, ids } = await ownerWithOpenings(texts);
        const res = await postJson('/api/chats/openings/land', { avatar_url: avatar, shown_text: 'gone', index: 12 });
        expect(res.body.index).toBe(12);
        expect(res.body.opening).toMatchObject({ node_id: ids[12], mes: texts[12] });
    });

    test('rule 3: an index past the end is clamped to the last opening', async () => {
        const texts = openings(5);
        const { avatar, ids } = await ownerWithOpenings(texts);
        const res = await postJson('/api/chats/openings/land', { avatar_url: avatar, shown_text: 'gone', index: 9 });
        expect(res.body.index).toBe(4);
        expect(res.body.opening.node_id).toBe(ids[4]);
    });

    test('no openings at all answers with no opening', async () => {
        const res = await postJson('/api/chats/openings/land', { avatar_url: 'land-nobody.png', shown_text: 'gone', index: 0 });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ index: -1, opening: null });
    });

    test('a missing shown_text, a bad index or too many edits is a 400', async () => {
        expect((await postJson('/api/chats/openings/land', { avatar_url: 'a.png', index: 0 })).status).toBe(400);
        expect((await postJson('/api/chats/openings/land', { avatar_url: 'a.png', shown_text: 'x', index: -1 })).status).toBe(400);
        expect((await postJson('/api/chats/openings/land', { avatar_url: 'a.png', shown_text: 'x', index: 1.5 })).status).toBe(400);
        const many = Array.from({ length: 65 }, () => ({ from: 'a', to: 'b' }));
        expect((await postJson('/api/chats/openings/land', { avatar_url: 'a.png', shown_text: 'x', index: 0, edits: many })).status).toBe(400);
    });
});
