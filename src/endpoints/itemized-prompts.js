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
 *
 * 2026-09-07 append-log rewrite: /save used to re-serialize, re-compress and re-write this chat's ENTIRE
 * history on every single call - and it's called after every single generated message
 * (saveItemizedPrompts() in public/scripts/itemized-prompts.js), so a long chat paid a full-history
 * disk write, every message, for what the client actually changed: one new entry (plus whatever new pool
 * strings it introduced - see that file's poolizeValue()). That's the worst "rewrite everything for a
 * small append" pattern in the app.
 *
 * The client's own pool-dedup format already makes the common case a real append: poolDedupIncremental()
 * reuses the unchanged prefix of both `pool` and `entries`, so on every ordinary "generate a message" save,
 * `data.pool` and `data.entries` are exactly the previous save's arrays with only new elements appended -
 * never mutated in place, never reordered. (Non-append cases exist too - editing/regenerating an earlier
 * message, or reordering/deleting entries via swapItemizedPrompts()/deleteItemizedPromptForMessage() -
 * those change an existing prefix element, not just add to the end.) So the format below stores each chat
 * as a short append-only log of frames: a `full` frame (the complete `{v, pool, entries}` - or, for
 * whatever came in from a legacy client/format, whatever opaque value was given) followed by zero or more
 * `append` frames (just the new `pool`/`entries` tail). On /save, the previous frames are read back and
 * compared against the incoming data; if the incoming data really is "previous state, plus a tail", only
 * that tail gets compressed and appended to the file - no re-compression or re-write of anything already on
 * disk. Anything that doesn't fit that shape (first save for a chat, a non-append edit, a `v` bump, or data
 * that isn't a plain `{..., entries: [...]}` object at all) falls back to a full rewrite, exactly like
 * before.
 *
 * Frame count is capped (COMPACT_THRESHOLD) so a very long chat doesn't turn every future /get, or the
 * appendability check on every future /save, into replaying thousands of tiny frames: once a chat has
 * accumulated that many append frames since its last full frame, the next /save writes a full frame instead
 * (compaction) rather than appending again. This bounds both frame count and the worst-case write frequency
 * to "at most one full rewrite per COMPACT_THRESHOLD messages" instead of "one full rewrite per message".
 *
 * On-disk layout of the new format (distinguished from the old raw-zstd format by a 4-byte magic prefix no
 * zstd frame can start with, so files written by the previous version of this endpoint keep reading
 * correctly - see readStoredFile()):
 *   MAGIC (4 bytes: "IPL1") | frame | frame | ...
 * each frame:
 *   length (4-byte LE uint32, byte length of the zstd-compressed record that follows) | zstd-compressed record
 * each record, once decompressed and JSON-parsed, is one of:
 *   { t: 'full', data: <opaque - whatever was saved> }
 *   { t: 'append', pool: [...new pool strings], entries: [...new entries] }
 */

const zstdCompress = promisify(zlib.zstdCompress);
const zstdDecompress = promisify(zlib.zstdDecompress);

/** 4-byte marker at the start of the new append-log file format. No zstd frame can start with these bytes
 * (a zstd frame's first 4 bytes are always its own magic number), so this safely distinguishes the two
 * formats without needing a file extension or naming change. */
const LOG_MAGIC = Buffer.from('IPL1', 'ascii');

/** Once a chat's file has this many `append` frames stacked since its last `full` frame, the next /save
 * compacts back down to a single `full` frame instead of appending again - see this file's top-of-file
 * comment. */
const COMPACT_THRESHOLD = 20;

export const router = express.Router();

/**
 * @param {import('express').Request} request
 * @param {string} chatId
 * @returns {string} Absolute path to this chat's itemized-prompts file (not guaranteed to exist).
 */
function getItemizedPromptsFilePath(request, chatId) {
    return path.join(request.user.directories.itemizedPrompts, `${sanitize(chatId)}.json.zst`);
}

/**
 * Encodes one record as a length-prefixed, zstd-compressed frame.
 * @param {object} record
 * @returns {Promise<Buffer>}
 */
async function encodeFrame(record) {
    const compressed = await zstdCompress(Buffer.from(JSON.stringify(record)));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(compressed.length, 0);
    return Buffer.concat([length, compressed]);
}

/**
 * Reads back whatever is stored for a chat, in whichever format it was written in.
 * @param {string} filePath
 * @returns {Promise<{kind: 'missing'} | {kind: 'legacy', raw: Buffer} | {kind: 'framed', data: *, appendFrameCount: number}>}
 *   `legacy`: pre-append-log format - a single raw zstd-compressed blob, `raw` is its decompressed bytes.
 *   `framed`: the append-log format - `data` is the fully reconstructed value (equivalent to what a legacy
 *   file's decompressed-and-parsed content would be), `appendFrameCount` is how many `append` frames were
 *   applied since the last `full` frame (used to decide when to compact).
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
        // Not our magic - either a pre-append-log file (a raw zstd frame), or something unreadable.
        // zstdDecompress throwing on genuinely corrupt data is left to the caller, same as before.
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
            // Truncated trailing frame (e.g. a crash mid-append) - stop here and use whatever fully-written
            // frames were already applied, rather than failing the whole read.
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
            // An `append` frame with no compatible preceding `full` frame - shouldn't happen since this
            // endpoint never writes one otherwise, but don't let a corrupt/foreign file crash the read.
            console.warn(`[Itemized Prompts] Unexpected frame in ${filePath}, ignoring it and everything after.`);
            break;
        }
    }

    return { kind: 'framed', data, appendFrameCount };
}

/**
 * If `newData` is exactly `prevData` with only new elements appended to its `pool`/`entries` arrays (the
 * shape poolDedupIncremental() in public/scripts/itemized-prompts.js produces on every ordinary "generate a
 * message" save), returns the new tail of each. Otherwise (first save, an edit/reorder/delete touching an
 * existing element, a `v` mismatch, or either value not being a plain `{..., entries: [...]}` object)
 * returns null, meaning: fall back to a full rewrite.
 * @param {*} prevData
 * @param {*} newData
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

/**
 * Writes `data` as a single `full` frame, replacing whatever was at `filePath` (same on-disk cost as the
 * old whole-file write, just in the new framed format).
 * @param {string} filePath
 * @param {*} data
 */
async function writeFullFrame(filePath, data) {
    const frame = await encodeFrame({ t: 'full', data });
    await writeFileAtomic(filePath, Buffer.concat([LOG_MAGIC, frame]));
}

/**
 * Appends a single `append` frame to an existing (already-framed) file. Not atomic the way writeFullFrame()
 * is - a crash mid-write can leave a truncated trailing frame - but readStoredFile() recovers from that by
 * just ignoring it, so the worst case is losing this one append (same durability the old code had for the
 * write it was in the middle of).
 * @param {string} filePath
 * @param {Array} poolTail
 * @param {Array} entriesTail
 */
async function appendFrame(filePath, poolTail, entriesTail) {
    const frame = await encodeFrame({ t: 'append', pool: poolTail, entries: entriesTail });
    await fs.promises.appendFile(filePath, frame);
}

/**
 * Saves `data` for a chat, writing no more than necessary: nothing at all if it's unchanged from what's
 * already stored, just the new tail if it's the previous data with only appended `pool`/`entries` elements,
 * or a full rewrite otherwise (see this file's top-of-file comment).
 * @param {string} filePath
 * @param {*} data
 */
async function saveItemizedPromptsData(filePath, data) {
    const stored = await readStoredFile(filePath);

    // Appending frame bytes onto the file only makes sense if the file is already in the framed format
    // (starts with LOG_MAGIC) - a legacy (pre-append-log) file is a single raw zstd frame with nothing to
    // append onto, even if its decoded content would otherwise look like a valid "previous state" to diff
    // against. Such a file always gets a one-time full rewrite (which upgrades it to the framed format),
    // same as a chat's very first save.
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
 * Bulk upload of a browser's locally-cached backlog in a single request (see
 * migrateAllItemizedPrompts() in public/scripts/itemized-prompts.js) - one request/response for the whole
 * backlog rather than a GET+POST per chat, since a large backlog (tens of thousands of chats) turned that
 * per-chat round-tripping into exactly the request flood this endpoint exists to avoid. Never clobbers a
 * chat that's already resident server-side (checked here, same "don't overwrite with a stale local
 * snapshot" rule the old per-chat flow enforced with its own GET-then-save) - such a chat is still reported
 * back as migrated, since either way the browser's local copy is safe to reclaim. Each chat is a one-shot
 * full snapshot (nothing to append onto yet), so this always writes a single `full` frame.
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
                // Leave this one chat off the migrated list - the client keeps its local copy and
                // retries it on a future boot - rather than failing the whole bulk request over one bad
                // chat.
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
