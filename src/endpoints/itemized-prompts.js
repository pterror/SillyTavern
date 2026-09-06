import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

/**
 * Server-side storage for per-chat itemized prompts (2026-09 SillyTavern_Prompts migration: this used to
 * be a client-only IndexedDB store - localforage's `SillyTavern_Prompts` instance in
 * public/scripts/itemized-prompts.js - which meant a chat's itemized breakdown simply didn't exist on any
 * OTHER device/browser than the one that generated it. Storing it here instead makes it resident data like
 * chats/characters already are: one file per chat, under this user's own directory).
 *
 * The client still does its own field-dedup + cross-entry rawPrompt diffing (public/scripts/
 * itemized-prompts.js's computeItemizedDedupSplit()/compressItemizedPromptsIncremental()) before ever
 * sending a payload here - that step still matters even with gzip added on top: gzip/deflate's window is
 * a fixed 32KB, so cross-entry duplication more than 32KB apart in the serialized JSON (easily the case
 * once a chat has run long, since each entry's rawPrompt alone can run to hundreds of KB) is invisible to
 * plain gzip no matter how good the compressor otherwise is. The client-side diffing catches exactly that
 * class of redundancy; gzip here on top squeezes the remaining unique text, which it's genuinely good at.
 * The two are complementary, not redundant with each other.
 */

export const router = express.Router();

/**
 * @param {import('express').Request} request
 * @param {string} chatId
 * @returns {string} Absolute path to this chat's itemized-prompts file (not guaranteed to exist).
 */
function getItemizedPromptsFilePath(request, chatId) {
    return path.join(request.user.directories.itemizedPrompts, `${sanitize(chatId)}.json.gz`);
}

router.post('/get', async function (request, response) {
    try {
        const chatId = request.body?.chatId;
        if (!chatId) {
            return response.sendStatus(400);
        }

        const filePath = getItemizedPromptsFilePath(request, chatId);
        if (!fs.existsSync(filePath)) {
            return response.sendStatus(404);
        }

        const compressed = fs.readFileSync(filePath);
        const json = zlib.gunzipSync(compressed).toString('utf8');
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

        if (!fs.existsSync(request.user.directories.itemizedPrompts)) {
            fs.mkdirSync(request.user.directories.itemizedPrompts, { recursive: true });
        }

        const filePath = getItemizedPromptsFilePath(request, chatId);
        const compressed = zlib.gzipSync(JSON.stringify(data));
        writeFileAtomicSync(filePath, compressed);
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
        if (fs.existsSync(filePath)) {
            fs.rmSync(filePath);
        }
        response.sendStatus(200);
    } catch (error) {
        console.error('[Itemized Prompts] Error deleting itemized prompts:', error);
        response.status(500).send({ error: true });
    }
});

router.post('/clear', async function (request, response) {
    try {
        const dir = request.user.directories.itemizedPrompts;
        if (fs.existsSync(dir)) {
            for (const file of fs.readdirSync(dir)) {
                fs.rmSync(path.join(dir, file));
            }
        }
        response.sendStatus(200);
    } catch (error) {
        console.error('[Itemized Prompts] Error clearing itemized prompts:', error);
        response.status(500).send({ error: true });
    }
});
