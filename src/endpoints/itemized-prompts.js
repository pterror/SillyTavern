import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

import express from 'express';
import sanitize from 'sanitize-filename';
import writeFileAtomic from 'write-file-atomic';

/**
 * Server-side storage for per-chat itemized prompts: one zstd-compressed file per chat, under the user's own
 * directory (previously a client-only IndexedDB store, so a chat's breakdown didn't follow it across devices).
 *
 * zstd instead of gzip/deflate: gzip's fixed 32KB window misses cross-entry duplication in long chats; zstd's
 * larger window covers it and is faster besides. Uses the async zlib API so compression runs off the event loop.
 *
 * Each chat's file is an append-only log of frames rather than a full rewrite per save: a `full` frame holds
 * the complete data, followed by zero or more `append` frames holding just the new `pool`/`entries` tail. A
 * save whose incoming data is exactly the previous data plus an appended tail (the common case - see
 * computeAppendable()) only compresses and appends that tail. Anything else (first save, an edit touching an
 * existing element, a `v` bump, or an incompatible shape) triggers a full rewrite.
 *
 * COMPACT_THRESHOLD bounds append-chain length: once a chat has that many append frames since its last full
 * frame, the next save writes a full frame instead, capping both frame count and read-replay cost.
 *
 * On-disk layout (a 4-byte magic prefix distinguishes this from the older raw-zstd format so old files still
 * read correctly - see readStoredFile()):
 *   MAGIC (4 bytes: "IPL1") | frame | frame | ...
 * each frame:
 *   length (4-byte LE uint32) | zstd-compressed record
 * each record, decompressed and parsed:
 *   { t: 'full', data: <opaque> }
 *   { t: 'append', pool: [...new pool strings], entries: [...new entries] }
 */

const zstdCompress = promisify(zlib.zstdCompress);
const zstdDecompress = promisify(zlib.zstdDecompress);

/** No zstd frame can start with these bytes, so this safely distinguishes the two file formats. */
const LOG_MAGIC = Buffer.from('IPL1', 'ascii');

const COMPACT_THRESHOLD = 20;

export const router = express.Router();

function getItemizedPromptsFilePath(request, chatId) {
    return path.join(request.user.directories.itemizedPrompts, `${sanitize(chatId)}.json.zst`);
}

/** Encodes one record as a length-prefixed, zstd-compressed frame. */
async function encodeFrame(record) {
    const compressed = await zstdCompress(Buffer.from(JSON.stringify(record)));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(compressed.length, 0);
    return Buffer.concat([length, compressed]);
}

/**
 * Reads back whatever is stored for a chat, in whichever format it was written in.
 * @returns {Promise<{kind: 'missing'} | {kind: 'legacy', raw: Buffer} | {kind: 'framed', data: *, appendFrameCount: number}>}
 *   `legacy`: pre-append-log format, `raw` is the decompressed bytes.
 *   `framed`: `data` is the reconstructed value, `appendFrameCount` is frames applied since the last `full` frame.
 */
async function readStoredFile(filePath) {
    let buffer;
    try {
        buffer = await fs.promises.readFile(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { kind: 'missing' };
        }
        throw error;
    }

    if (buffer.length < LOG_MAGIC.length || !buffer.subarray(0, LOG_MAGIC.length).equals(LOG_MAGIC)) {
        // No magic prefix: a pre-append-log file (a raw zstd frame).
        const raw = await zstdDecompress(buffer);
        return { kind: 'legacy', raw };
    }

    let data = undefined;
    let appendFrameCount = 0;
    let offset = LOG_MAGIC.length;
    while (offset + 4 <= buffer.length) {
        const frameLength = buffer.readUInt32LE(offset);
        offset += 4;
        if (offset + frameLength > buffer.length) {
            console.warn(`[Itemized Prompts] Truncated trailing frame in ${filePath}, ignoring it and everything after.`);
            break;
        }
        const frameBuf = buffer.subarray(offset, offset + frameLength);
        offset += frameLength;

        let record;
        try {
            record = JSON.parse((await zstdDecompress(frameBuf)).toString('utf8'));
        } catch (error) {
            console.warn(`[Itemized Prompts] Corrupt frame in ${filePath}, ignoring it and everything after:`, error);
            break;
        }

        if (record?.t === 'full') {
            data = record.data;
            appendFrameCount = 0;
        } else if (record?.t === 'append' && data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.entries)) {
            data = {
                ...data,
                pool: [...(Array.isArray(data.pool) ? data.pool : []), ...(Array.isArray(record.pool) ? record.pool : [])],
                entries: [...data.entries, ...(Array.isArray(record.entries) ? record.entries : [])],
            };
            appendFrameCount++;
        } else {
            // Shouldn't happen from this endpoint's own writes; don't let a corrupt/foreign file crash the read.
            console.warn(`[Itemized Prompts] Unexpected frame in ${filePath}, ignoring it and everything after.`);
            break;
        }
    }

    return { kind: 'framed', data, appendFrameCount };
}

/**
 * Returns the new `pool`/`entries` tail if `newData` is `prevData` with only elements appended, else null
 * (falls back to a full rewrite).
 * @returns {{poolTail: Array, entriesTail: Array} | null}
 */
function computeAppendable(prevData, newData) {
    if (!isEntriesShape(prevData) || !isEntriesShape(newData)) {
        return null;
    }
    if (prevData.v !== newData.v) {
        return null;
    }

    const prevPool = Array.isArray(prevData.pool) ? prevData.pool : [];
    const newPool = Array.isArray(newData.pool) ? newData.pool : [];
    if (newPool.length < prevPool.length || !arrayHasPrefix(newPool, prevPool)) {
        return null;
    }

    const prevEntries = prevData.entries;
    const newEntries = newData.entries;
    if (newEntries.length < prevEntries.length || !arrayHasPrefix(newEntries, prevEntries, deepEqual)) {
        return null;
    }

    return { poolTail: newPool.slice(prevPool.length), entriesTail: newEntries.slice(prevEntries.length) };
}

/** @param {*} value @returns {boolean} */
function isEntriesShape(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.entries);
}

/**
 * @param {Array} longer
 * @param {Array} prefix
 * @param {(a: *, b: *) => boolean} [equals]
 * @returns {boolean} Whether `longer`'s first `prefix.length` elements equal `prefix`, element-wise.
 */
function arrayHasPrefix(longer, prefix, equals = (a, b) => a === b) {
    for (let i = 0; i < prefix.length; i++) {
        if (!equals(longer[i], prefix[i])) {
            return false;
        }
    }
    return true;
}

/** @param {*} a @param {*} b @returns {boolean} */
function deepEqual(a, b) {
    if (a === b) {
        return true;
    }
    return JSON.stringify(a) === JSON.stringify(b);
}

async function writeFullFrame(filePath, data) {
    const frame = await encodeFrame({ t: 'full', data });
    await writeFileAtomic(filePath, Buffer.concat([LOG_MAGIC, frame]));
}

/** Not atomic like writeFullFrame() - a crash mid-write leaves a truncated frame, which readStoredFile() ignores. */
async function appendFrame(filePath, poolTail, entriesTail) {
    const frame = await encodeFrame({ t: 'append', pool: poolTail, entries: entriesTail });
    await fs.promises.appendFile(filePath, frame);
}

async function saveItemizedPromptsData(filePath, data) {
    const stored = await readStoredFile(filePath);

    // A legacy (pre-append-log) file has nothing to append onto - always gets a one-time full rewrite.
    const appendable = stored.kind === 'framed' ? computeAppendable(stored.data, data) : null;
    if (appendable) {
        if (appendable.poolTail.length === 0 && appendable.entriesTail.length === 0) {
            return; // Nothing changed since last save - nothing to write.
        }
        if (stored.appendFrameCount < COMPACT_THRESHOLD - 1) {
            await appendFrame(filePath, appendable.poolTail, appendable.entriesTail);
            return;
        }
    }

    await writeFullFrame(filePath, data);
}

router.post('/get', async function (request, response) {
    try {
        const chatId = request.body?.chatId;
        if (!chatId) {
            return response.sendStatus(400);
        }

        const filePath = getItemizedPromptsFilePath(request, chatId);
        const stored = await readStoredFile(filePath);
        if (stored.kind === 'missing') {
            return response.sendStatus(404);
        }
        if (stored.kind === 'legacy') {
            response.type('application/json').send(stored.raw.toString('utf8'));
            return;
        }
        response.type('application/json').send(JSON.stringify(stored.data));
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
        await saveItemizedPromptsData(filePath, data);
        response.sendStatus(200);
    } catch (error) {
        console.error('[Itemized Prompts] Error saving itemized prompts:', error);
        response.status(500).send({ error: true });
    }
});

/**
 * Bulk upload of a browser's locally-cached backlog in one request instead of a GET+POST per chat. Never
 * clobbers a chat already resident server-side, but still reports it as migrated (the local copy is safe to
 * reclaim either way).
 */
router.post('/migrate', async function (request, response) {
    try {
        const chats = request.body?.chats;
        if (!Array.isArray(chats)) {
            return response.sendStatus(400);
        }

        await fs.promises.mkdir(request.user.directories.itemizedPrompts, { recursive: true });

        const migrated = [];
        await Promise.all(chats.map(async (chat) => {
            const chatId = chat?.chatId;
            const data = chat?.data;
            if (!chatId || data === undefined) {
                return;
            }

            try {
                const filePath = getItemizedPromptsFilePath(request, chatId);
                let alreadyPresent = true;
                try {
                    await fs.promises.access(filePath);
                } catch (error) {
                    if (error.code !== 'ENOENT') {
                        throw error;
                    }
                    alreadyPresent = false;
                }

                if (!alreadyPresent) {
                    await writeFullFrame(filePath, data);
                }

                migrated.push(chatId);
            } catch (error) {
                // Left off the migrated list so the client retries it later, rather than failing the whole batch.
                console.error(`[Itemized Prompts] Error migrating chat ${chatId}:`, error);
            }
        }));

        response.json({ migrated });
    } catch (error) {
        console.error('[Itemized Prompts] Error in bulk migration:', error);
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
