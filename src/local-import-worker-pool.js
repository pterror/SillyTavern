import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import { getConfigFilePath, getConfigValue } from './util.js';

const WORKER_MODULE_PATH = fileURLToPath(new URL('./local-import-worker.js', import.meta.url));

const DEFAULT_POOL_SIZE_CAP = 16;

/**
 * @typedef {object} WorkerPoolTask
 * @property {number} id
 * @property {(result: any) => void} onParsed
 * @property {(result: any) => void} onDone
 * @property {(err: Error) => void} reject
 */

/**
 * @typedef {object} PoolWorkerSlot
 * @property {Worker} worker
 * @property {WorkerPoolTask | null} currentTask
 */

export class LocalImportWorkerPool {
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

    _spawnSlot() {
        const worker = new Worker(WORKER_MODULE_PATH, { workerData: { configFilePath: getConfigFilePath() }, stdout: true, stderr: true });
        worker.stdout.on('data', chunk => process.stdout.write(chunk));
        worker.stderr.on('data', chunk => process.stderr.write(chunk));
        const slot = { worker, currentTask: null };

        worker.on('message', (result) => {
            const task = slot.currentTask;
            if (!task) return;

            if (result.phase === 'parsed') {
                task.onParsed(result);
                return;
            }

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
            const index = this.slots.indexOf(slot);
            try {
                worker.terminate();
            } catch { /* already gone */ }
            if (index !== -1) {
                this.slots[index] = this._spawnSlot();
                this._pump(this.slots[index]);
            }
        });

        return slot;
    }

    _pump(slot) {
        if (slot.currentTask || this.disposed) return;
        const task = this.pending.shift();
        if (!task) return;
        slot.currentTask = task;
        const args = this.taskArgsById.get(task.id);
        slot.worker.postMessage(args);
    }

    /**
     * @param {string} sourcePath
     * @param {string} format
     * @param {import('./users.js').UserDirectoryList} directories
     * @param {boolean} allowIdentityFallback
     * @returns {Promise< { contentHash: string, jsonClassification: string | null, identityHash: string | null, avatarIdentityHash: string | null, needsWrite: false } | { contentHash: string, jsonClassification: null, identityHash: string | null, avatarIdentityHash: string | null, needsWrite: true, rawText: string, finish: (outcome: { type: 'no-write' } | { type: 'write' }) => Promise<{ outcome: string, image?: { image: Buffer, avatarHash: string, avatarIdentityHash: string } }> } >}
     */
    runPipeline(sourcePath, format, directories, allowIdentityFallback) {
        const id = this.nextId++;
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
     * @param {number} id
     * @param {{ type: 'no-write' } | { type: 'write' }} outcome
     * @returns {Promise<{ outcome: string, image?: { image: Buffer, avatarHash: string, avatarIdentityHash: string } }>}
     */
    _finish(id, outcome) {
        const slot = this.slots.find(s => s.currentTask?.id === id);
        return new Promise((resolve, reject) => {
            if (!slot) {
                reject(new Error(`local-import worker pool: no in-flight task for id ${id} (worker crashed or pool disposed between phases)`));
                return;
            }
            slot.currentTask.onDone = (result) => resolve({
                outcome: result.outcome,
                ...(result.image ? { image: { image: Buffer.from(result.image), avatarHash: result.avatarHash, avatarIdentityHash: result.avatarIdentityHash } } : {}),
            });
            slot.currentTask.reject = reject;
            slot.worker.postMessage({ id, type: 'continue', outcome: outcome.type === 'write' ? 'write' : 'no-write' });
        });
    }

    /**
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
