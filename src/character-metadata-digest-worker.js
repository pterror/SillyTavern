import { parentPort } from 'node:worker_threads';

import { getSqliteEngine } from './endpoints/sqlite-engine.js';
import { bucketOf, emptyDigest, combineDigest, characterDigestContentHash, DEFAULT_DIGEST_BUCKET_COUNT } from '../public/scripts/hash-utils.js';

/**
 * worker_threads entry point for character-metadata-db.js's getStateDigest()/getBucketMembers() - the two
 * full-`characters`-table anti-entropy scans behind `POST /api/characters/state-digest` and
 * `POST /api/characters/bucket-members` (see those functions' own doc comments for the full mechanism). Moved
 * off the main thread (2026-08 state-digest perf investigation) because a real 326k-row `characters` table
 * measured ~2.2s of synchronous JS (JSON.parse + fingerprint extraction + hashing) for this scan alone, on top
 * of another ~0.5s for the row fetch itself - on the main Express event loop, that's ~2.7s where every other
 * request on this Node process (chat completions, file writes, everything) queues up behind it. Follows
 * local-import-worker.js's own precedent for why the worker owns its OWN read here rather than the main thread
 * fetching rows and shipping them over `postMessage`: shipping ~326k `{id, shallow_json}` pairs through a
 * structured-clone message would itself cost roughly what the row fetch already costs, for no benefit - a
 * dedicated read-only connection opened right here is simpler and, under this engine's WAL journal mode (see
 * sqlite-engine.js's openNativeDatabase()), safe to run concurrently alongside the main thread's own persistent
 * connection to the same file (multiple readers under WAL never block each other or the main connection).
 *
 * DELIBERATELY never touches the main thread's persistent `entries` connection cache
 * (character-metadata-db.js's own `getEntry()`) - opens and closes its own handle per call, since this is a
 * rare, on-demand anti-entropy check (once per client page session, not a hot per-request path) rather than
 * something worth keeping a warm pool of workers around for the way local-import-worker-pool.js's high-
 * throughput per-file dispatch does. One spawn-per-call (tens of ms of Worker startup, per that pool's own
 * header) is immaterial next to the multi-second scan it's replacing.
 *
 * CHUNKED, NOT ONE LONG SYNCHRONOUS SWEEP: even though this already runs off the main thread, the per-row
 * hash/fold loop below still yields back to THIS worker's own event loop every CHUNK_SIZE rows (via
 * `setImmediate`) rather than running start-to-finish as one blocking stretch - so a future addition (a
 * cancellation message, a second concurrent request to this same worker) has somewhere to land instead of
 * queuing behind a multi-second synchronous block same as before, just relocated to a different thread.
 */

/** Rows processed between yields - see this module's own header on why the loop yields at all despite already
 * running off the main thread. Large enough that `setImmediate`'s own overhead (a macrotask hop) stays a small
 * fraction of total time (~65 yields for a 326k-row table), small enough that no single yield gap is long. */
const CHUNK_SIZE = 5000;

/**
 * @param {string} dbPath
 * @returns {Promise<import('./endpoints/sqlite-engine.js').SqliteEngineHandle | null>}
 */
async function openReadOnly(dbPath) {
    const engine = await getSqliteEngine();
    if (!engine) return null;
    return engine.openDatabase(dbPath);
}

/**
 * @param {string} dbPath
 * @param {number} bucketCount
 * @returns {Promise<{ buckets: { hi: number, lo: number }[] } | null>}
 */
async function computeStateDigest(dbPath, bucketCount) {
    const db = await openReadOnly(dbPath);
    if (!db) return null;
    try {
        const rows = db.all('SELECT id, shallow_json FROM characters');
        const buckets = Array.from({ length: bucketCount }, () => emptyDigest());
        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            for (let j = i; j < Math.min(i + CHUNK_SIZE, rows.length); j++) {
                const row = rows[j];
                const idx = bucketOf(row.id, bucketCount);
                buckets[idx] = combineDigest(buckets[idx], row.id, characterDigestContentHash(JSON.parse(row.shallow_json)));
            }
            await new Promise((resolve) => setImmediate(resolve));
        }
        return { buckets };
    } finally {
        db.close();
    }
}

/**
 * @param {string} dbPath
 * @param {number} bucket
 * @param {number} bucketCount
 * @returns {Promise<{ members: { id: string, contentHash: number }[] } | null>}
 */
async function computeBucketMembers(dbPath, bucket, bucketCount) {
    const db = await openReadOnly(dbPath);
    if (!db) return null;
    try {
        const rows = db.all('SELECT id, shallow_json FROM characters');
        const members = [];
        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            for (let j = i; j < Math.min(i + CHUNK_SIZE, rows.length); j++) {
                const row = rows[j];
                if (bucketOf(row.id, bucketCount) === bucket) {
                    members.push({ id: row.id, contentHash: characterDigestContentHash(JSON.parse(row.shallow_json)) });
                }
            }
            await new Promise((resolve) => setImmediate(resolve));
        }
        return { members };
    } finally {
        db.close();
    }
}

parentPort.on('message', async (msg) => {
    try {
        if (msg.type === 'state-digest') {
            const result = await computeStateDigest(msg.dbPath, msg.bucketCount);
            parentPort.postMessage({ id: msg.id, ok: true, result });
            return;
        }
        if (msg.type === 'bucket-members') {
            const result = await computeBucketMembers(msg.dbPath, msg.bucket, msg.bucketCount);
            parentPort.postMessage({ id: msg.id, ok: true, result });
            return;
        }
        parentPort.postMessage({ id: msg.id, ok: false, error: `Unknown message type: ${msg.type}` });
    } catch (err) {
        parentPort.postMessage({ id: msg.id, ok: false, error: /** @type {any} */ (err)?.message ?? String(err) });
    }
});
