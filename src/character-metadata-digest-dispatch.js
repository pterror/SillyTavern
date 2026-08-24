import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const WORKER_MODULE_PATH = fileURLToPath(new URL('./character-metadata-digest-worker.js', import.meta.url));

/**
 * Spawns one character-metadata-digest-worker.js worker, sends it a single task, and resolves with that task's
 * result - see that worker's own header for why this is a spawn-per-call rather than a persistent pool
 * (local-import-worker-pool.js's own shape) the way the local-import feature needs: getStateDigest()/
 * getBucketMembers() are a rare, on-demand anti-entropy check (at most once per client page session - see
 * script.js's `hasVerifiedCharacterCacheDigestThisSession`), not a hot per-request path, so there's no steady-
 * state throughput to amortize a warm pool against.
 *
 * The `await` here is real async - Node's event loop keeps servicing every other request while this worker
 * computes its result off-thread; nothing about this call ties up the main thread's event loop the way the
 * inline synchronous loop this replaces did.
 * @param {{ type: 'state-digest', dbPath: string, bucketCount: number } | { type: 'bucket-members', dbPath: string, bucket: number, bucketCount: number } | { type: 'tree-descend', dbPath: string, nodes: { path: number[] }[], branching: number, leafThreshold: number } | { type: 'resolve-fingerprints', dbPath: string, ids: string[] }} task
 * @returns {Promise<any>} Whatever the worker's `result` field was for this task (`null` if the metadata store
 * turned out to be unavailable inside the worker - same contract getStateDigest()/getBucketMembers() already
 * have for their callers). For a `'state-digest'` task, `result` is
 * `{ favBuckets: {hi,lo}[], contentBuckets: {hi,lo}[] }` - two parallel bucket-digest tables (fav-fields vs
 * content-fields, see hash-utils.js's `characterDigestFavHash()`/`characterDigestFieldsHash()`). For a
 * `'bucket-members'` task, `result` is `{ members: { id: string, favHash: number, fieldsHash: number, fav:
 * boolean }[] }` - `fav` is the row's actual current value, so a fav-only mismatch can be repaired with no
 * further fetch.
 * For a `'tree-descend'` task, `result` is `{ results: { path: number[], type: 'children'|'leaves', children?:
 * {fav,fields}[], members?: object[] }[] }` - one entry per requested node, either its children hashes (subtree
 * larger than `leafThreshold`) or its full leaf member data (including fingerprint values) for direct repair.
 */
export function runDigestWorkerTask(task) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_MODULE_PATH);
        const id = 0; // Single in-flight task per worker instance - no need for real id routing.

        const cleanup = () => {
            worker.removeAllListeners();
            worker.terminate().catch(() => { /* already exiting */ });
        };

        worker.on('message', (msg) => {
            if (msg.id !== id) return; // Defensive - shouldn't happen, this worker only ever gets one task.
            cleanup();
            if (msg.ok) {
                resolve(msg.result);
            } else {
                reject(new Error(msg.error));
            }
        });
        worker.on('error', (err) => {
            cleanup();
            reject(err);
        });

        worker.postMessage({ id, ...task });
    });
}
