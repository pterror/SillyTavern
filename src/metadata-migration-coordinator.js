import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import { characterChangeEmitter, clearTagCache, waitForMetadataBootChain } from './character-metadata-db.js';
import { color, getConfigFilePath } from './util.js';

const WORKER_MODULE_PATH = fileURLToPath(new URL('./metadata-migration-worker.js', import.meta.url));
const DISPOSE_TIMEOUT_MS = 10000;

/** The one-time passes metadata-migration-worker.js runs, in the order they must run. */
export const MIGRATION_PASSES = /** @type {const} */ ([
    'recoverNumericIdGroupsIfNeeded',
    'normalizeGroupFavIfNeeded',
    'migrateTagsJsonIfNeeded',
    'backfillCardTagsIfNeeded',
    'backfillTagIdsInShallowJson',
    'normalizeCharacterFavIfNeeded',
    'normalizeCharacterTagIdsIfNeeded',
]);

/**
 * @typedef {{ postMessage(msg: object): void, on(event: string, listener: (...args: any[]) => void): any, terminate(): Promise<number> | void, unref?(): void }} MigrationWorker
 * @typedef {{ worker: MigrationWorker, exited: Promise<void>, disposing: boolean }} WorkerEntry
 */

/** @param {object} workerData */
function spawnMigrationWorker(workerData) {
    return new Worker(WORKER_MODULE_PATH, { workerData });
}

/**
 * Runs each user store's one-time metadata migration passes in a worker thread of its own (one per store, with its
 * own database connection), so they never hold up the server or its requests. A store's worker starts only once
 * that store's boot chain (initializeMetadataStores()) has finished, and not at all if the chain failed, since the
 * passes rely on what it populates. Keeps this process in step with what the worker writes: after each batch that
 * wrote tag definitions the store's tag cache is cleared, and after each batch that wrote change rows 'change' is
 * emitted once.
 * @param {object} [options]
 * @param {(workerData: object) => MigrationWorker} [options.spawnWorker]
 * @param {(directories: import('./users.js').UserDirectoryList) => Promise<boolean>} [options.waitForBootChain]
 * @param {(directories: import('./users.js').UserDirectoryList) => Promise<void>} [options.onTagDefinitionsChanged]
 * @param {() => void} [options.onChanged]
 */
export function createMetadataMigrationCoordinator({
    spawnWorker = spawnMigrationWorker,
    waitForBootChain = waitForMetadataBootChain,
    onTagDefinitionsChanged = clearTagCache,
    onChanged = () => characterChangeEmitter.emit('change'),
} = {}) {
    /** @type {Map<string, WorkerEntry>} */
    const entries = new Map();
    /** @type {Map<string, Promise<void>>} */
    const starts = new Map();
    let disposed = false;

    /**
     * @param {import('./users.js').UserDirectoryList} directories
     * @param {WorkerEntry} entry
     * @param {any} msg
     */
    async function handleMessage(directories, entry, msg) {
        switch (msg?.type) {
            case 'batch': {
                if (msg.tagDefinitionsChanged) await onTagDefinitionsChanged(directories);
                if (msg.changed) onChanged();
                return;
            }
            case 'error': {
                console.error(color.red(`[metadata-migrations] ${msg.message}`));
                return;
            }
        }
    }

    /**
     * @param {import('./users.js').UserDirectoryList} directories
     * @returns {Promise<void>} Settles once the store's worker has exited (at once when none was started).
     */
    async function run(directories) {
        if (!(await waitForBootChain(directories))) {
            console.error(color.red(`[metadata-migrations] Not running the migration passes for ${directories.root} this boot: its metadata boot chain did not complete.`));
            return;
        }
        if (disposed) return;

        const worker = spawnWorker({ directories, configPath: getConfigFilePath() });
        worker.unref?.();
        /** @type {() => void} */
        let markExited = () => {};
        /** @type {WorkerEntry} */
        const entry = { worker, exited: new Promise(resolve => { markExited = resolve; }), disposing: false };
        // Messages are handled one at a time, in order.
        let handled = Promise.resolve();
        worker.on('message', (msg) => {
            handled = handled.then(() => handleMessage(directories, entry, msg)).catch((err) => {
                console.error(color.red(`[metadata-migrations] handling a migration worker message failed: ${err?.message ?? err}`));
            });
        });
        worker.on('error', (err) => {
            console.error(color.red(`[metadata-migrations] migration worker for ${directories.root} failed: ${err?.message ?? err}`));
        });
        worker.on('exit', (code) => {
            if (code !== 0 && !entry.disposing) {
                console.error(color.red(`[metadata-migrations] migration worker for ${directories.root} exited (code ${code})`));
            }
            if (entries.get(directories.root) === entry) {
                entries.delete(directories.root);
            }
            handled.then(markExited);
        });
        entries.set(directories.root, entry);
        await entry.exited;
    }

    return {
        /**
         * Starts the store's migration worker once its boot chain has finished. One per store: a second call
         * returns the first one's promise.
         * @param {import('./users.js').UserDirectoryList} directories
         * @returns {Promise<void>} Settles once the store's worker has exited and its messages are handled.
         */
        start(directories) {
            let started = starts.get(directories.root);
            if (!started) {
                started = run(directories);
                starts.set(directories.root, started);
            }
            return started;
        },

        /**
         * Asks every running worker to stop before its next pass and waits for it to exit; one that hasn't
         * exited within DISPOSE_TIMEOUT_MS is terminated. Workers not yet started never start.
         */
        async dispose() {
            disposed = true;
            await Promise.all([...entries.values()].map(async (entry) => {
                entry.disposing = true;
                entry.worker.postMessage({ type: 'close' });
                let timer;
                const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve(true), DISPOSE_TIMEOUT_MS); });
                const outcome = await Promise.race([entry.exited.then(() => false), timedOut]);
                clearTimeout(timer);
                if (outcome) {
                    await entry.worker.terminate();
                }
            }));
        },
    };
}

const metadataMigrationCoordinator = createMetadataMigrationCoordinator();

/**
 * Starts each store's migration worker once its boot chain finishes. Meant to be called after the server listens,
 * without awaiting it.
 * @param {import('./users.js').UserDirectoryList[]} directoriesList
 * @returns {Promise<void>} Settles once every started worker has exited.
 */
export async function startMetadataMigrations(directoriesList) {
    await Promise.all(directoriesList.map(directories => metadataMigrationCoordinator.start(directories)));
}

export function disposeMetadataMigrationWorkers() {
    return metadataMigrationCoordinator.dispose();
}
