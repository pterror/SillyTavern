import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

import express from 'express';
import sanitize from 'sanitize-filename';
import writeFileAtomic from 'write-file-atomic';

/**
 * Server-side storage for per-chat itemized prompts (2026-09 SillyTavern_Prompts migration: this used to
 * be a client-only IndexedDB store - localforage's `SillyTavern_Prompts` instance in
 * public/scripts/itemized-prompts.js - which meant a chat's itemized breakdown simply didn't exist on any
 * OTHER device/browser than the one that generated it. Storing it here instead makes it resident data like
 * chats/characters already are: one file per chat, under this user's own directory).
 *
 * Compressed at rest with zstd rather than gzip/deflate: gzip's window is a fixed 32KB, so cross-entry
 * duplication further apart than that in the serialized JSON - easily the case once a chat has run long,
 * since a single entry's content can run to hundreds of KB - is invisible to it no matter how good the
 * compressor otherwise is. zstd's default window (up to 8MB at the levels used here) covers realistic
 * chat sizes, and it's also faster than both gzip and brotli at a comparable ratio, which matters since
 * this is now on the request path for every save/get (client-side compression was removed - see
 * public/scripts/itemized-prompts.js's pool-dedup rewrite - specifically because doing that work sync on
 * the browser's main thread made the app unusable; this file uses the async zlib API for the same reason,
 * so a large chat's compression work here runs on libuv's threadpool instead of blocking Node's single
 * event loop thread for every other concurrent request - this matters a lot for the local-IndexedDB-backlog
 * migration, which can have dozens of uploads in flight at once).
 */

const zstdCompress = promisify(zlib.zstdCompress);
const zstdDecompress = promisify(zlib.zstdDecompress);

export const router = express.Router();

/**
 * @param {import('express').Request} request
 * @param {string} chatId
 * @returns {string} Absolute path to this chat's itemized-prompts file (not guaranteed to exist).
 */
function getItemizedPromptsFilePath(request, chatId) {
    return path.join(request.user.directories.itemizedPrompts, `${sanitize(chatId)}.json.zst`);
}

router.post('/get', async function (request, response) {
    try {
        const chatId = request.body?.chatId;
        if (!chatId) {
            return response.sendStatus(400);
        }

        const filePath = getItemizedPromptsFilePath(request, chatId);
        let compressed;
        try {
            compressed = await fs.promises.readFile(filePath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return response.sendStatus(404);
            }
            throw error;
        }

        const json = (await zstdDecompress(compressed)).toString('utf8');
        response.type('application/json').send(json);
    } catch (error) {
        console.error('[Itemized Prompts] Error reading itemized prompts:', error);
        response.status(500).send({ error: true });
    }
});

router.post('/save', async function (request, response) {
    try {
        const chatId = request.body?.chatId;
        const data = request.body?.data;
        if (!chatId || data === undefined) {
            return response.sendStatus(400);
        }

        await fs.promises.mkdir(request.user.directories.itemizedPrompts, { recursive: true });

        const filePath = getItemizedPromptsFilePath(request, chatId);
        const compressed = await zstdCompress(JSON.stringify(data));
        await writeFileAtomic(filePath, compressed);
        response.sendStatus(200);
    } catch (error) {
        console.error('[Itemized Prompts] Error saving itemized prompts:', error);
        response.status(500).send({ error: true });
    }
});

router.post('/delete', async function (request, response) {
    try {
        const chatId = request.body?.chatId;
        if (!chatId) {
            return response.sendStatus(400);
        }

        const filePath = getItemizedPromptsFilePath(request, chatId);
        await fs.promises.rm(filePath, { force: true });
        response.sendStatus(200);
    } catch (error) {
        console.error('[Itemized Prompts] Error deleting itemized prompts:', error);
        response.status(500).send({ error: true });
    }
});

router.post('/clear', async function (request, response) {
    try {
        const dir = request.user.directories.itemizedPrompts;
        await fs.promises.rm(dir, { recursive: true, force: true });
        await fs.promises.mkdir(dir, { recursive: true });
        response.sendStatus(200);
    } catch (error) {
        console.error('[Itemized Prompts] Error clearing itemized prompts:', error);
        response.status(500).send({ error: true });
    }
});
