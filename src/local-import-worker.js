import fs from 'node:fs';
import crypto from 'node:crypto';
import { parentPort } from 'node:worker_threads';

import { classifyJsonCandidate, computeCandidateContentIdentityHash } from './local-import-classify.js';

/**
 * worker_threads entry point for local-import-scan.js's worker pool (see local-import-worker-pool.js and
 * local-import-scan.js's PROCESSING SPLIT header comment for the full architecture). Runs the CPU-bound half
 * of processFile()'s per-file work, entirely inside this thread: reads the source file's bytes itself
 * (fs.readFileSync - the multi-megabyte buffer never crosses the thread boundary in either direction, only
 * `sourcePath`/`format` in and a small `{contentHash, jsonClassification, identityHash}` result out - the
 * exact shape confirmed to matter for real throughput in the 2026-08 local-import worker-pool investigation's
 * bench-worker-selfread.mjs prototype), computes the sha256 content hash and (format-dependent) the
 * candidate content-identity hash via the same pure helpers local-import-scan.js used to run inline.
 *
 * DELIBERATELY NEVER TOUCHES SQLITE, directly or transitively: this module only imports
 * local-import-classify.js (see that module's own header on why it's safe/DB-free) plus Node builtins.
 * character-metadata-db.js's better-sqlite3 handle is a native addon object bound to the thread that opened
 * it - it cannot be handed to a worker via postMessage (native handles aren't structured-cloneable), and
 * independently opening a SECOND connection to the same database file from a worker thread while the main
 * thread may be mid-transaction (scanDirectory() wraps a whole pass in beginBatchImport()/endBatchImport(),
 * and this fork's character-metadata-db.js never configures WAL journal mode or a busy_timeout - confirmed
 * by reading that module's schema/pragma setup during this investigation) would risk SQLITE_BUSY errors or
 * worse against the main thread's still-open write transaction. So every dedup lookup
 * (findCharacterIdByContentHash/findCharacterIdByContentIdentityHash), every skip/mtime-cache write, and the
 * actual import/write (importCharacterFileHeadless) stays on the main thread, serialized exactly as before -
 * only the pure hashing/parsing work this file does is what actually moves off it.
 *
 * One message in, one message back, no persistent per-worker state between messages (aside from the
 * process's own module cache) - a worker crashing/throwing on one malformed file (e.g. a corrupt PNG) only
 * ever fails that one task's promise on the pool side (see local-import-worker-pool.js's 'error' handling);
 * it does not carry over into the next message this same worker (or its replacement) handles.
 */
parentPort.on('message', async (msg) => {
    const { id, sourcePath, format, allowIdentityFallback } = msg;
    try {
        const sourceBuffer = fs.readFileSync(sourcePath);
        const contentHash = crypto.createHash('sha256').update(sourceBuffer).digest('hex');

        let jsonClassification = null;
        if (format === 'json') {
            jsonClassification = classifyJsonCandidate(sourceBuffer);
        }

        let identityHash = null;
        // Only worth computing when nothing above already decided this file's fate - mirrors
        // processFile()'s original ordering (skip-classification short-circuits before the identity-hash
        // fallback is ever attempted), just evaluated here instead of on the main thread. The
        // `directories` argument computeCandidateContentIdentityHash() needs travels over the wire as
        // `msg.directories` - the plain UserDirectoryList object of path strings (see users.js), fully
        // structured-cloneable, sent as-is by local-import-worker-pool.js's run().
        if (!jsonClassification && allowIdentityFallback) {
            identityHash = await computeCandidateContentIdentityHash(sourceBuffer, format, msg.directories);
        }

        parentPort.postMessage({ id, ok: true, contentHash, jsonClassification, identityHash });
    } catch (err) {
        parentPort.postMessage({ id, ok: false, error: /** @type {any} */ (err)?.message ?? String(err) });
    }
});
