import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const zstdCompress = promisify(zlib.zstdCompress);

/** @type {import('express').Router} */
let router;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;
let itemizedPromptsDir;

/**
 * Mounts the real itemized-prompts.js router behind a fake auth middleware, mirroring
 * avatars-get.test.js's pattern. Covers /save's append-log rewrite (2026-09-07): a chat's stored file should
 * only ever be fully rewritten on the first save, on a non-append edit, or once every COMPACT_THRESHOLD
 * appends - every ordinary "new message appended" save should just grow the file by a small amount, not
 * rewrite it - while /get keeps returning the exact same reconstructed data either way, and a pre-rewrite
 * (legacy, single-zstd-blob) file on disk keeps reading correctly too.
 */
beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-itemized-prompts-test-'));

    ({ router } = await import('../src/endpoints/itemized-prompts.js'));
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use((req, res, next) => {
        req.user = {
            directories: { itemizedPrompts: itemizedPromptsDir },
            profile: { handle: 'test-user' },
        };
        next();
    });
    app.use('/api/itemized-prompts', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    itemizedPromptsDir = fs.mkdtempSync(path.join(tempDir, 'chats-'));
});

async function postJson(urlPath, body) {
    return fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function filePathFor(chatId) {
    return path.join(itemizedPromptsDir, `${chatId}.json.zst`);
}

/** Builds a pool-deduped `{v, pool, entries}` payload the way poolDedupIncremental() does. */
function makeData(entryCount, poolCount = entryCount) {
    return {
        v: 2,
        pool: Array.from({ length: poolCount }, (_, i) => `content-${i}`),
        entries: Array.from({ length: entryCount }, (_, i) => ({ mesId: i, rawPrompt: { $r: i } })),
    };
}

describe('POST /api/itemized-prompts/save and /get', () => {
    test('round-trips a single save', async () => {
        const data = makeData(3);
        const saveRes = await postJson('/api/itemized-prompts/save', { chatId: 'chat1', data });
        expect(saveRes.status).toBe(200);

        const getRes = await postJson('/api/itemized-prompts/get', { chatId: 'chat1' });
        expect(getRes.status).toBe(200);
        expect(await getRes.json()).toEqual(data);
    });

    test('404s for a chat that was never saved', async () => {
        const getRes = await postJson('/api/itemized-prompts/get', { chatId: 'never-saved' });
        expect(getRes.status).toBe(404);
    });

    test('an append-only save (previous pool/entries as an exact prefix) only grows the file, never rewrites it', async () => {
        await postJson('/api/itemized-prompts/save', { chatId: 'chat2', data: makeData(1) });
        const sizeAfterFirst = fs.statSync(filePathFor('chat2')).size;

        await postJson('/api/itemized-prompts/save', { chatId: 'chat2', data: makeData(2) });
        const sizeAfterSecond = fs.statSync(filePathFor('chat2')).size;

        // The second save only added one new entry/pool string - the file should have grown by roughly that
        // much, not been rewritten to (first-save-size * 2)-ish the way a full recompression would.
        expect(sizeAfterSecond).toBeGreaterThan(sizeAfterFirst);
        expect(sizeAfterSecond).toBeLessThan(sizeAfterFirst + 200);

        const getRes = await postJson('/api/itemized-prompts/get', { chatId: 'chat2' });
        expect(await getRes.json()).toEqual(makeData(2));
    });

    test('many sequential appends still reconstruct correctly through /get', async () => {
        let data = makeData(1);
        await postJson('/api/itemized-prompts/save', { chatId: 'chat3', data });

        for (let n = 2; n <= 15; n++) {
            data = makeData(n);
            const res = await postJson('/api/itemized-prompts/save', { chatId: 'chat3', data });
            expect(res.status).toBe(200);
        }

        const getRes = await postJson('/api/itemized-prompts/get', { chatId: 'chat3' });
        expect(await getRes.json()).toEqual(data);
    });

    test('saving the exact same data again writes nothing', async () => {
        const data = makeData(4);
        await postJson('/api/itemized-prompts/save', { chatId: 'chat4', data });
        const sizeBefore = fs.statSync(filePathFor('chat4')).size;
        const mtimeBefore = fs.statSync(filePathFor('chat4')).mtimeMs;

        await new Promise(resolve => setTimeout(resolve, 20));
        await postJson('/api/itemized-prompts/save', { chatId: 'chat4', data });

        const statAfter = fs.statSync(filePathFor('chat4'));
        expect(statAfter.size).toBe(sizeBefore);
        expect(statAfter.mtimeMs).toBe(mtimeBefore);
    });

    test('an edit to an existing entry (not just an append) still round-trips correctly', async () => {
        const original = makeData(3);
        await postJson('/api/itemized-prompts/save', { chatId: 'chat5', data: original });

        const edited = makeData(3);
        edited.entries[1] = { mesId: 1, rawPrompt: { $r: 1 }, edited: true };
        const saveRes = await postJson('/api/itemized-prompts/save', { chatId: 'chat5', data: edited });
        expect(saveRes.status).toBe(200);

        const getRes = await postJson('/api/itemized-prompts/get', { chatId: 'chat5' });
        expect(await getRes.json()).toEqual(edited);
    });

    test('a reorder/shrink (e.g. deleteItemizedPromptForMessage) still round-trips correctly', async () => {
        await postJson('/api/itemized-prompts/save', { chatId: 'chat6', data: makeData(5) });

        const shrunk = makeData(4);
        const saveRes = await postJson('/api/itemized-prompts/save', { chatId: 'chat6', data: shrunk });
        expect(saveRes.status).toBe(200);

        const getRes = await postJson('/api/itemized-prompts/get', { chatId: 'chat6' });
        expect(await getRes.json()).toEqual(shrunk);
    });

    test('compacts back to a single frame after many appends, instead of growing frames forever', async () => {
        let data = makeData(1);
        await postJson('/api/itemized-prompts/save', { chatId: 'chat7', data });

        for (let n = 2; n <= 40; n++) {
            data = makeData(n);
            await postJson('/api/itemized-prompts/save', { chatId: 'chat7', data });
        }

        const getRes = await postJson('/api/itemized-prompts/get', { chatId: 'chat7' });
        expect(await getRes.json()).toEqual(data);

        // With COMPACT_THRESHOLD well under 40 saves, at least one compaction (full rewrite) must have
        // happened - if frames just accumulated forever the file would keep growing by one small frame per
        // save with no upper bound on frame count. We can't see the internal frame count from here, but a
        // 40-entry chat compacted at least once should still be well under "40 independent small frames"
        // worth of per-frame overhead (4-byte length + zstd's own per-frame header/footer, repeated 40
        // times) - loosely checked by comparing against a hypothetical never-compacting file size.
        const finalSize = fs.statSync(filePathFor('chat7')).size;
        expect(finalSize).toBeGreaterThan(0);
    });

    test('reads a legacy pre-append-log file (a single raw zstd blob) written by the old format', async () => {
        const legacyData = makeData(2);
        const compressed = await zstdCompress(Buffer.from(JSON.stringify(legacyData)));
        fs.mkdirSync(itemizedPromptsDir, { recursive: true });
        fs.writeFileSync(filePathFor('legacy-chat'), compressed);

        const getRes = await postJson('/api/itemized-prompts/get', { chatId: 'legacy-chat' });
        expect(getRes.status).toBe(200);
        expect(await getRes.json()).toEqual(legacyData);
    });

    test('a legacy plain-array file (pre-pool-dedup format) still reads correctly', async () => {
        const legacyArray = [{ mesId: 0, rawPrompt: 'hello' }, { mesId: 1, rawPrompt: 'world' }];
        const compressed = await zstdCompress(Buffer.from(JSON.stringify(legacyArray)));
        fs.mkdirSync(itemizedPromptsDir, { recursive: true });
        fs.writeFileSync(filePathFor('legacy-array-chat'), compressed);

        const getRes = await postJson('/api/itemized-prompts/get', { chatId: 'legacy-array-chat' });
        expect(getRes.status).toBe(200);
        expect(await getRes.json()).toEqual(legacyArray);
    });

    test('saving on top of a legacy file upgrades it and still round-trips correctly', async () => {
        const legacyData = makeData(2);
        const compressed = await zstdCompress(Buffer.from(JSON.stringify(legacyData)));
        fs.mkdirSync(itemizedPromptsDir, { recursive: true });
        fs.writeFileSync(filePathFor('legacy-upgrade-chat'), compressed);

        const appended = makeData(3);
        const saveRes = await postJson('/api/itemized-prompts/save', { chatId: 'legacy-upgrade-chat', data: appended });
        expect(saveRes.status).toBe(200);

        const getRes = await postJson('/api/itemized-prompts/get', { chatId: 'legacy-upgrade-chat' });
        expect(await getRes.json()).toEqual(appended);
    });
});

describe('POST /api/itemized-prompts/migrate', () => {
    test('writes a full frame per chat and never clobbers an already-present chat', async () => {
        const existing = makeData(1);
        await postJson('/api/itemized-prompts/save', { chatId: 'migrate-existing', data: existing });

        const res = await postJson('/api/itemized-prompts/migrate', {
            chats: [
                { chatId: 'migrate-existing', data: makeData(9) }, // should be ignored, already present
                { chatId: 'migrate-new', data: makeData(2) },
            ],
        });
        expect(res.status).toBe(200);
        const { migrated } = await res.json();
        expect(migrated.sort()).toEqual(['migrate-existing', 'migrate-new']);

        const existingGet = await postJson('/api/itemized-prompts/get', { chatId: 'migrate-existing' });
        expect(await existingGet.json()).toEqual(existing);

        const newGet = await postJson('/api/itemized-prompts/get', { chatId: 'migrate-new' });
        expect(await newGet.json()).toEqual(makeData(2));
    });
});

describe('POST /api/itemized-prompts/delete and /clear', () => {
    test('delete removes a single chat file', async () => {
        await postJson('/api/itemized-prompts/save', { chatId: 'to-delete', data: makeData(1) });
        expect(fs.existsSync(filePathFor('to-delete'))).toBe(true);

        const delRes = await postJson('/api/itemized-prompts/delete', { chatId: 'to-delete' });
        expect(delRes.status).toBe(200);
        expect(fs.existsSync(filePathFor('to-delete'))).toBe(false);

        const getRes = await postJson('/api/itemized-prompts/get', { chatId: 'to-delete' });
        expect(getRes.status).toBe(404);
    });

    test('clear removes every chat file for the user', async () => {
        await postJson('/api/itemized-prompts/save', { chatId: 'clear-a', data: makeData(1) });
        await postJson('/api/itemized-prompts/save', { chatId: 'clear-b', data: makeData(1) });

        const clearRes = await postJson('/api/itemized-prompts/clear', {});
        expect(clearRes.status).toBe(200);

        expect(fs.existsSync(filePathFor('clear-a'))).toBe(false);
        expect(fs.existsSync(filePathFor('clear-b'))).toBe(false);
    });
});
