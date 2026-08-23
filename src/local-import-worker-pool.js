import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import { getConfigValue } from './util.js';

const WORKER_MODULE_PATH = fileURLToPath(new URL('./local-import-worker.js', import.meta.url));

/** Hard cap on the auto-detected default pool size, regardless of core count - see
 * initializeLocalImportWorkerPool()'s doc comment for why an unbounded `os.cpus().length` default is the
 * wrong call even on a very large machine. */
const DEFAULT_POOL_SIZE_CAP = 16;

/**
 * @typedef {object} WorkerPoolTask
 * @property {number} id
 * @property {(result: any) => void} onParsed Called for a 'parsed' phase message (see local-import-worker.js's
 * two-phase protocol) - resolves runPipeline()'s own promise with a `needsWrite: true` result. Never called for
 * a task that only ever sends a single 'done' (charx/byaf/yaml, or a jsonClassification skip).
 * @property {(result: any) => void} onDone Called for the task's current terminal 'done' message. Reassigned by
 * _finish() to a NEW resolver once a 'parsed'-phase task's finish() is invoked, so the SAME task object keeps
 * routing messages correctly across both phases.
 * @property {(err: Error) => void} reject Rejects whichever promise (runPipeline()'s own, or a finish()-created
 * one) is currently outstanding for this task - reassigned by _finish() the same way onDone is.
 */

/**
 * @typedef {object} PoolWorkerSlot
 * @property {Worker} worker
 * @property {WorkerPoolTask | null} currentTask Set while this worker is handling a dispatched task, null
 * when idle - lets a crashed/errored worker's replacement know which single in-flight task (if any) to
 * reject before a fresh Worker takes this slot.
 */

/**
 * A small persistent pool of local-import-worker.js worker_threads, sized once at creation and reused across
 * every file dispatched to it for a pool's lifetime (see local-import-scan.js's callers - one pool per
 * scan-lifecycle, not one per file/pass: worker_threads startup (~tens of ms to spin up a V8 isolate) is not
 * free, and the whole point of this feature is throughput on a large corpus, not incurring that cost per
 * file).
 *
 * Task dispatch is a simple work-stealing queue: `run()` either hands the task straight to an idle worker or
 * appends to `pending` for the next worker that frees up - the same "N persistent workers pull from one
 * shared queue" shape mapWithConcurrency() (util.js) already uses for bounded-concurrency async work, just
 * backed by real OS threads instead of interleaved promises, because this pool's per-task work is genuinely
 * CPU-bound (see local-import-worker.js's own header) rather than I/O-bound.
 *
 * Error isolation: a worker that throws/crashes on one malformed file only fails THAT task's promise (see
 * the 'error' listener below) - the pool immediately spins up a replacement Worker in the same slot and
 * keeps serving the rest of the queue, so one bad file never takes down the whole pool or the in-flight scan
 * pass (this module's whole reason for existing is a directory scan that may cover hundreds of thousands of
 * files, most of which this pool never sees ahead of time - a single poison file must not stop the pass).
 */
export class LocalImportWorkerPool {
    /**
     * @param {number} size
     */
    constructor(size) {
        /** @type {PoolWorkerSlot[]} */
        this.slots = [];
        /** @type {WorkerPoolTask[]} */
        this.pending = [];
        /** @type {Map<number, { id: number, sourcePath: string, format: string, directories: object, allowIdentityFallback: boolean }>} */
        this.taskArgsById = new Map();
        this.nextId = 0;
        this.disposed = false;
        for (let i = 0; i < size; i++) {
            this.slots.push(this._spawnSlot());
        }
    }

    /**
     * @returns {PoolWorkerSlot}
     */
    _spawnSlot() {
        const worker = new Worker(WORKER_MODULE_PATH);
        const slot = { worker, currentTask: null };

        worker.on('message', (result) => {
            const task = slot.currentTask;
            if (!task) return; // Stray message after dispose/replacement - nothing to resolve.

            if (result.phase === 'parsed') {
                // Two-phase task (see local-import-worker.js's own header): the worker is now holding this
                // file's buffer/chunks, waiting for a follow-up 'continue' message on this SAME id - the slot
                // stays busy (currentTask untouched, no _pump()) until that arrives and the worker sends its
                // real terminal 'done'.
                task.onParsed(result);
                return;
            }

            // phase === 'done' - either a single-phase task's only message, or a two-phase task's follow-up
            // response to _finish()'s 'continue' - either way, this task is now fully resolved and the slot is
            // free for the next one.
            slot.currentTask = null;
            this.taskArgsById.delete(task.id);
            if (result.ok) {
                task.onDone(result);
            } else {
                task.reject(new Error(result.error));
            }
            this._pump(slot);
        });

        worker.on('error', (err) => {
            const task = slot.currentTask;
            slot.currentTask = null;
            if (task) task.reject(err);
            if (this.disposed) return;
            // Replace this slot's worker in place so the pool's total size never shrinks because one file
            // crashed a thread - see this class's own header on why that matters for a long scan pass.
            const index = this.slots.indexOf(slot);
            try {
                worker.terminate();
            } catch { /* already gone */ }
            if (index !== -1) {
                this.slots[index] = this._spawnSlot();
                this._pump(this.slots[index]);
            }
        });

        // Deliberately NOT worker.unref()'d, unlike local-import-scan.js's own scanTimeout - that timer is
        // idle time BETWEEN passes and should never itself hold the process open, but a worker here holding
        // real in-flight dispatched work is a genuine pending async operation, exactly like an outstanding
        // fs read would be. unref()'ing it was tried and found actively unsafe, not just unnecessary: with
        // nothing else anchoring the event loop (e.g. a standalone script/benchmark that does nothing but
        // await this pool, rather than a full server with its own listen() socket and other timers), Node
        // can decide the loop is "empty" and exit while a dispatched task's response is still in flight,
        // permanently orphaning that task's promise (reproduced directly: a bench script's only
        // await-the-pool call never resolved, and Node logged "Detected unsettled top-level await" right as
        // it exited). Worker thread lifetime is bounded correctly some other way instead - explicit
        // dispose()/terminate() calls tied to the scan lifecycle (disposeLocalImportScan()) - not by making
        // the process willing to abandon a worker mid-task.
        return slot;
    }

    /**
     * @param {PoolWorkerSlot} slot
     */
    _pump(slot) {
        if (slot.currentTask || this.disposed) return;
        const task = this.pending.shift();
        if (!task) return;
        slot.currentTask = task;
        const args = this.taskArgsById.get(task.id);
        slot.worker.postMessage(args);
    }

    /**
     * Runs one file's ENTIRE CPU-bound pipeline on whichever worker is next free, queueing if every worker is
     * currently busy - hash/classify/identity (as the original hash-only pool did), PLUS (2026-08 worker-
     * owned-write extension, png/json only - see local-import-worker.js's own header) the actual write to the
     * target character file, all against the SAME single in-worker read of `sourcePath`'s bytes.
     *
     * Resolves first with either a terminal result (`needsWrite: false` - charx/byaf/yaml, or a
     * jsonClassification permanent-skip) or a `needsWrite: true` result carrying the worker's already-parsed
     * `rawText` and a `finish()` callback. The caller (local-import-scan.js's processFile()) is expected to run
     * its own per-hash-locked sqlite dedup check using `contentHash`/`identityHash` before ever calling
     * `finish()` - the worker is just sitting there holding this file's buffer/chunks in memory in the
     * meantime, doing nothing else, exactly as if this were still one synchronous call. `finish()` itself never
     * needs to be awaited more than once per task and must always be called exactly once for a `needsWrite:
     * true` result (with `{ type: 'no-write' }` if the caller decides nothing should be written) - never
     * calling it leaves that worker's slot permanently stuck "busy" for the rest of this pool's lifetime.
     * @param {string} sourcePath
     * @param {string} format
     * @param {import('./users.js').UserDirectoryList} directories
     * @param {boolean} allowIdentityFallback Mirrors `performance.allowExpensiveDuplicateFallback` - read once
     * by the caller (local-import-scan.js's processFile()) before dispatch and passed through here, rather than
     * re-read inside the worker, so the worker never wastes CPU computing an identity hash the config would
     * just have discarded on the main thread anyway.
     * @returns {Promise<
     *   { contentHash: string, jsonClassification: string | null, identityHash: string | null, avatarIdentityHash: string | null, needsWrite: false } |
     *   { contentHash: string, jsonClassification: null, identityHash: string | null, avatarIdentityHash: string | null, needsWrite: true, rawText: string,
     *     finish: (outcome: { type: 'no-write' } | { type: 'write', destPath: string, data: string }) => Promise<{ outcome: string, reflinked?: boolean }> }
     * >}
     */
    runPipeline(sourcePath, format, directories, allowIdentityFallback) {
        const id = this.nextId++;
        // `directories` is a plain object of path strings (UserDirectoryList - see users.js) - passed through
        // as-is rather than cherry-picking fields, since it's fully structured-cloneable and
        // computeCandidateContentIdentityHash()'s call chain doesn't dereference any specific property of it
        // on the paths this pool's tasks actually take (confirmed by inspection of character-card-normalize.js).
        this.taskArgsById.set(id, { id, sourcePath, format, directories, allowIdentityFallback });
        return new Promise((resolve, reject) => {
            /** @type {WorkerPoolTask} */
            const task = {
                id,
                onParsed: (result) => {
                    resolve({
                        contentHash: result.contentHash,
                        jsonClassification: result.jsonClassification,
                        identityHash: result.identityHash,
                        avatarIdentityHash: result.avatarIdentityHash,
                        needsWrite: true,
                        rawText: result.rawText,
                        finish: (outcome) => this._finish(id, outcome),
                    });
                },
                onDone: (result) => {
                    resolve({
                        contentHash: result.contentHash,
                        jsonClassification: result.jsonClassification,
                        identityHash: result.identityHash,
                        avatarIdentityHash: result.avatarIdentityHash,
                        needsWrite: false,
                    });
                },
                reject,
            };
            const idleSlot = this.slots.find(s => !s.currentTask);
            if (idleSlot) {
                idleSlot.currentTask = task;
                idleSlot.worker.postMessage(this.taskArgsById.get(id));
            } else {
                this.pending.push(task);
            }
        });
    }

    /**
     * Sends the follow-up 'continue' message for an in-flight two-phase task (see runPipeline()'s own doc
     * comment) to whichever slot is still holding it, and returns a promise for the final write outcome. Only
     * ever invoked via a runPipeline() result's own `finish()` closure - never called directly with an
     * arbitrary id from outside this class.
     * @param {number} id
     * @param {{ type: 'no-write' } | { type: 'write', destPath: string, data: string }} outcome
     * @returns {Promise<{ outcome: string, reflinked?: boolean }>}
     */
    _finish(id, outcome) {
        const slot = this.slots.find(s => s.currentTask?.id === id);
        return new Promise((resolve, reject) => {
            if (!slot) {
                // The worker holding this task crashed (or the pool was disposed) between phase 1 and this
                // finish() call - see the 'error' handler and dispose(), both of which reject whatever was
                // outstanding for a task at the time. Nothing to send.
                reject(new Error(`local-import worker pool: no in-flight task for id ${id} (worker crashed or pool disposed between phases)`));
                return;
            }
            // Rebind this task's resolver/rejector to THIS promise - worker.on('message')'s 'done' branch and
            // the 'error' handler both just call whatever onDone/reject currently point at, so this is what
            // makes the eventual response route back here instead of to runPipeline()'s already-settled promise.
            slot.currentTask.onDone = (result) => resolve({ outcome: result.outcome, reflinked: result.reflinked });
            slot.currentTask.reject = reject;
            slot.worker.postMessage(outcome.type === 'write'
                ? { id, type: 'continue', outcome: 'write', destPath: outcome.destPath, data: outcome.data }
                : { id, type: 'continue', outcome: 'no-write' });
        });
    }

    /**
     * Terminates every worker in the pool and rejects any still-pending queued tasks - called once the scan
     * this pool belongs to is disposed (see local-import-scan.js's disposeLocalImportScan()), so no worker
     * thread outlives the scan lifecycle it was created for, and never leaks across server shutdown or a
     * config-driven re-init.
     * @returns {Promise<void>}
     */
    async dispose() {
        this.disposed = true;
        for (const task of this.pending) {
            task.reject(new Error('local-import worker pool disposed before this task was dispatched'));
        }
        this.pending = [];
        await Promise.all(this.slots.map(slot => {
            if (slot.currentTask) {
                slot.currentTask.reject(new Error('local-import worker pool disposed while this task was in flight'));
            }
            return slot.worker.terminate();
        }));
        this.slots = [];
    }
}

/**
 * `performance.localImportWorkerPoolSize` from config.yaml if set to a positive integer, otherwise an
 * auto-detected default. Read fresh (not cached at module scope) so a config change takes effect on the
 * next scan (re)init the same way every other localImport./performance. knob in this feature already does -
 * see local-import-scan.js's own getConfigValue() call sites.
 *
 * Default is `os.cpus().length` capped at DEFAULT_POOL_SIZE_CAP (16), not left unbounded: the 2026-08
 * local-import worker-pool investigation measured monotonic, real scaling through 2/4/8/16 workers on a
 * 24-core benchmark machine with NO plateau observed in that range - but it also never tested past 16, so
 * defaulting to "however many cores this machine happens to have" on a very large machine would extrapolate
 * past measured evidence rather than rely on it. Capping the AUTO-DETECTED default at 16 keeps that default
 * inside the range this feature was actually benchmarked at; an owner on a bigger machine who wants to push
 * past that measured range can still do so explicitly via the config knob itself, which enforces no upper
 * bound of its own.
 * @returns {number}
 */
export function resolveWorkerPoolSize() {
    const configured = getConfigValue('performance.localImportWorkerPoolSize', 0, 'number');
    if (Number.isInteger(configured) && configured > 0) {
        return configured;
    }
    const detected = os.cpus().length || 1;
    return Math.max(1, Math.min(detected, DEFAULT_POOL_SIZE_CAP));
}
