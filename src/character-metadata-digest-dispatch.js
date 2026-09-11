import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const WORKER_MODULE_PATH = fileURLToPath(new URL('./character-metadata-digest-worker.js', import.meta.url));

/**
 * Spawn-per-call rather than a persistent pool: this is a rare, on-demand anti-entropy check, not a hot path.
 * @param {{ type: 'state-digest', dbPath: string, bucketCount: number } | { type: 'bucket-members', dbPath: string, bucket: number, bucketCount: number } | { type: 'tree-descend', dbPath: string, nodes: { path: number[] }[], branching: number, leafThreshold: number } | { type: 'resolve-fingerprints', dbPath: string, ids: string[] } | { type: 'root-digest', dbPath: string }} task
 * @returns {Promise<any>} The worker's `result` field (`null` if the metadata store was unavailable).
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
