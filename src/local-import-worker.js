import fs from 'node:fs';
import crypto from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import extract from 'png-chunks-extract';

import { classifyJsonCandidate, computeCandidateContentIdentityHash } from './local-import-classify.js';
import { readFromChunks, writeCardFromChunks, writeCardToFile } from './character-card-parser.js';
import { DEFAULT_AVATAR_PATH } from './constants.js';

/**
 * worker_threads entry point for local-import-scan.js's worker pool (see local-import-worker-pool.js and
 * local-import-scan.js's PROCESSING SPLIT header comment for the full architecture). Owns the FULL per-file
 * CPU-bound pipeline for the two formats a real corpus is overwhelmingly made of - png and json - reading the
 * source file's bytes exactly once and reusing that single in-memory buffer (and, for png, its single chunk
 * extraction) all the way through hashing, classification, the identity-hash fallback, AND the eventual write
 * to the target character file. This closes a real, measured redundant-read gap the original (2026-08) hash-
 * only worker split left behind: before this extension, a file's bytes were read up to 3 times across one
 * import - once here to hash, once by readCharacterData()/fs.readFileSync() on the MAIN thread to get the
 * business-logic data out of a staged copy, and once more by writeCardToFile()'s own read when it built the
 * final write. Now there is exactly one `fs.readFileSync(sourcePath)` per file, full stop.
 *
 * TWO-PHASE PROTOCOL (see local-import-worker-pool.js's runPipeline()/_finish() for the main-thread half):
 * this only applies to png/json candidates that aren't already a permanent-skip (jsonClassification === null).
 * For those, and for every other tracked format (charx/byaf/yaml - see below), this behaves exactly like the
 * original single-message protocol: one 'start' message in, one final `{ phase: 'done' }` message back,
 * `pendingTasks` never touched.
 *
 *   1. Main -> Worker: `{ id, sourcePath, format, directories, allowIdentityFallback }` (no `type` - the
 *      original message shape, unchanged).
 *   2. Worker -> Main: `{ id, phase: 'parsed', ok: true, contentHash, jsonClassification: null, identityHash,
 *      rawText }` - `rawText` is the raw embedded card JSON text (ccv3-preferring for png, the file's own utf8
 *      text for json - see decodeRawText() below), everything the main thread's buildPngImportData()/
 *      buildJsonImportData() (characters.js) need to run their pure spec-dispatch/sanitize business logic
 *      without ANY further file I/O. The worker does NOT reply with a terminal 'done' yet - it stashes
 *      `sourceBuffer`/`chunks` in `pendingTasks` (keyed by `id`) and waits for this exact task's follow-up
 *      message. The pool-side slot stays "busy" for this whole span (see LocalImportWorkerPool's own header) -
 *      this worker thread does nothing else in the meantime, same as if it were still synchronously running.
 *   3. Main -> Worker: `{ id, type: 'continue', outcome: 'no-write' }` (a duplicate, or a shape
 *      buildPngImportData()/buildJsonImportData() couldn't recognize - nothing to write) OR
 *      `{ id, type: 'continue', outcome: 'write', destPath, data }` (the caller's per-hash-locked sqlite dedup
 *      check - see local-import-scan.js's withPerHashLock() - found this file genuinely new, and computed the
 *      final Spec V2 `data` string and target `destPath` to embed it at).
 *   4. Worker -> Main: `{ id, phase: 'done', ok: true, outcome, reflinked? }` - for 'write', this reuses
 *      `pendingTasks.get(id)`'s already-extracted `chunks`/`sourceBuffer` via writeCardFromChunks() (png) or
 *      re-reads only the tiny, fixed DEFAULT_AVATAR_PATH asset via writeCardToFile() (json - json-derived
 *      cards were never reflinked from their own per-file source to begin with, see writeCharacterData()'s own
 *      header, so there is no redundant SOURCE-file read being reintroduced here). `pendingTasks`' entry for
 *      `id` is always deleted before this message goes out, win or lose - no per-task state survives past its
 *      own 'done'.
 *
 * SCOPE: charx/byaf/yaml stay entirely on the single-message protocol and never populate `rawText` - those
 * formats need real archive/YAML parsing this worker has no reason to duplicate, and none of them reflink from
 * a real per-file source either way (charx/byaf extract an image from inside their own archive; yaml, like
 * json, only ever writes through the tiny fixed DEFAULT_AVATAR_PATH asset) - so there is no redundant per-file
 * read for this extension to close for them. local-import-scan.js's processFile() keeps driving those three
 * through the pre-existing stageFile()+importCharacterFileHeadless() path, unchanged.
 *
 * DELIBERATELY NEVER TOUCHES SQLITE, directly or transitively, in EITHER phase: this module only imports
 * local-import-classify.js, character-card-parser.js, constants.js, and Node/png builtins - never
 * character-metadata-db.js, never endpoints/characters.js's route-registration machinery. Every sqlite call
 * (findCharacterIdByContentHash/findCharacterIdByContentIdentityHash's dedup checks, and the final
 * upsertCharacterFromWrite() metadata-store hook) stays on the main thread, run only AFTER this worker's phase-2
 * 'done' confirms a write actually landed - see local-import-scan.js's processFile() for exactly where. See the
 * original (2026-08) hash-only worker's header for the full reasoning on why worker-thread sqlite access is
 * unsafe here (no WAL journal mode/busy_timeout configured, and scanDirectory() wraps a whole pass in one write
 * transaction).
 *
 * One task's `pendingTasks` entry is the only per-task state this module ever holds, and it is always cleared
 * (success or failure) before that task's final message goes out - a worker crashing/throwing on one malformed
 * file only ever fails that one task's promise on the pool side (see local-import-worker-pool.js's error
 * handling); it does not carry over into the next message this same worker (or its replacement) handles.
 */

/** @type {Map<number, { sourcePath: string, sourceBuffer: Buffer, chunks: Array<{name: string, data: Uint8Array}> | null, format: string }>} */
const pendingTasks = new Map();

/**
 * @param {Buffer} sourceBuffer
 * @param {string} format
 * @returns {{ rawText: string, chunks: Array<{name: string, data: Uint8Array}> | null }}
 */
function decodeRawText(sourceBuffer, format) {
    if (format === 'png') {
        const chunks = extract(new Uint8Array(sourceBuffer));
        return { rawText: readFromChunks(chunks), chunks };
    }
    // json: the file's own bytes ARE the card data - no extraction needed, and (unlike png) nothing here is
    // ever reflinked from this buffer, so there's no chunk list worth keeping around either.
    return { rawText: sourceBuffer.toString('utf8'), chunks: null };
}

parentPort.on('message', async (msg) => {
    if (msg.type === 'continue') {
        const pending = pendingTasks.get(msg.id);
        pendingTasks.delete(msg.id);
        if (!pending) return; // Stray/duplicate continue (shouldn't happen - defensive only).
        await finishWrite(msg, pending);
        return;
    }

    const { id, sourcePath, format, allowIdentityFallback } = msg;
    try {
        const sourceBuffer = fs.readFileSync(sourcePath);
        const contentHash = crypto.createHash('sha256').update(sourceBuffer).digest('hex');

        let jsonClassification = null;
        if (format === 'json') {
            jsonClassification = classifyJsonCandidate(sourceBuffer);
        }

        let identityHash = null;
        if (!jsonClassification && allowIdentityFallback) {
            identityHash = await computeCandidateContentIdentityHash(sourceBuffer, format, msg.directories);
        }

        if (!jsonClassification && (format === 'png' || format === 'json')) {
            const { rawText, chunks } = decodeRawText(sourceBuffer, format);
            pendingTasks.set(id, { sourcePath, sourceBuffer, chunks, format });
            parentPort.postMessage({ id, phase: 'parsed', ok: true, contentHash, jsonClassification, identityHash, rawText });
            return;
        }

        parentPort.postMessage({ id, phase: 'done', ok: true, contentHash, jsonClassification, identityHash });
    } catch (err) {
        parentPort.postMessage({ id, phase: 'done', ok: false, error: /** @type {any} */ (err)?.message ?? String(err) });
    }
});

/**
 * @param {{ id: number, outcome: 'no-write' | 'write', destPath?: string, data?: string }} msg
 * @param {{ sourcePath: string, sourceBuffer: Buffer, chunks: Array<{name: string, data: Uint8Array}> | null, format: string }} pending
 */
async function finishWrite(msg, pending) {
    const { id, outcome } = msg;
    if (outcome !== 'write') {
        parentPort.postMessage({ id, phase: 'done', ok: true, outcome });
        return;
    }
    try {
        const { destPath, data } = msg;
        const result = pending.format === 'png'
            ? await writeCardFromChunks(pending.sourcePath, destPath, pending.sourceBuffer, pending.chunks, data)
            // json never reflinks from its own source (see this module's header) - same DEFAULT_AVATAR_PATH
            // read writeCharacterData() already paid on the main thread before this extension, just relocated.
            : await writeCardToFile(DEFAULT_AVATAR_PATH, destPath, data);
        parentPort.postMessage({ id, phase: 'done', ok: true, outcome: 'write', reflinked: result.reflinked });
    } catch (err) {
        parentPort.postMessage({ id, phase: 'done', ok: false, error: /** @type {any} */ (err)?.message ?? String(err) });
    }
}
