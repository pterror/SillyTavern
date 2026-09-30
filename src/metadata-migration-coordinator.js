import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import { characterChangeEmitter, clearTagCache, kickChatStatsReconcile, reportTagChanges, reportTagMoveFailed, reportTagOrderSettled, waitForMetadataBootChain } from './character-metadata-db.js';
import { isReadOnlyMode } from './read-only-mode.js';
import { color, getConfigFilePath } from './util.js';

const WORKER_MODULE_PATH = fileURLToPath(new URL('./metadata-migration-worker.js', import.meta.url));
const DISPOSE_TIMEOUT_MS = 10000;

/** The one-time passes metadata-migration-worker.js runs, in the order they must run. */
export const MIGRATION_PASSES = /** @type {const} */ ([
    // First: until it has run, card tag names that only a table lookup could resolve are held, not assigned.
    'fillTagNameKeysIfNeeded',
    'fillTagDerivedColumnsIfNeeded',
    'recoverNumericIdGroupsIfNeeded',
    'normalizeGroupFavIfNeeded',
    'migrateTagsJsonIfNeeded',
    'migrateSettingsTagsIfNeeded',
    'backfillCardTagsIfNeeded',
    'backfillTagIdsInShallowJson',
    'normalizeCharacterFavIfNeeded',
    'normalizeCharacterTagIdsIfNeeded',
    'removeOrphanTagRowsIfNeeded',
    'refreshGroupDigestTagIdsIfNeeded',
    'finishDeletedTags',
    // After every pass that writes tags rows, migrateTagsJsonIfNeeded's tags without a sort_order included.
    'fillTagSortOrdersIfNeeded',
    // After the sort_order fill, which it waits for; tags/reorder also asks for it on its own.
    'runTagReorderPassIfNeeded',
    // Writes only the message tree.
    'dropTreeOwnerCreatedAtIndex',
    // Runs every boot: reads the metadata store, writes only the message tree.
    'fillTreeOwnerKinds',
    // Last: until its walk passes an entity, the counter triggers skip that entity's writes, so the passes above
    // don't also write counters.
    'fillEntityCountsIfNeeded',
]);

/**
 * @typedef {{ postMessage(msg: object): void, on(event: string, listener: (...args: any[]) => void): any, terminate(): Promise<number> | void, unref?(): void }} MigrationWorker
 * @typedef {{ worker: MigrationWorker, exited: Promise<void>, disposing: boolean }} WorkerEntry
 * @typedef {{ passes: Set<string>, boot: boolean, done: Promise<void>, settle: () => void }} QueuedRun
 * @typedef {{ current: QueuedRun | null, next: QueuedRun | null }} StoreRuns
 */

/** @param {object} workerData */
function spawnMigrationWorker(workerData) {
    return new Worker(WORKER_MODULE_PATH, { workerData });
}

/**
 * Runs each user store's metadata migration passes in a worker thread (with its own database connection), so they
 * never hold up the server or its requests: all of them once per boot (start()), and any one of them on demand
 * (request()). A store has at most one worker at a time; a run asked for while one is going runs once it has
 * exited, and every request made meanwhile joins that one run. A store's worker starts only once that store's boot
 * chain (initializeMetadataStores()) has finished, and not at all if the chain failed, since the passes rely on what
 * it populates. Keeps this process in step with what the worker writes: after each batch that
 * wrote tag definitions the store's tag cache is cleared, after each batch that logged tag changes the store's
 * clients are told (reportTagChanges()), and after each batch that wrote change rows 'change' is emitted once. A queued tag move the worker couldn't apply is reported here (reportTagMoveFailed()). A pass that
 * inserts rows queues their chat stats, which only this thread counts (kickChatStatsReconcile()), so the count is
 * started after each batch and once the worker has exited.
 * @param {object} [options]
 * @param {(workerData: object) => MigrationWorker} [options.spawnWorker]
 * @param {(directories: import('./users.js').UserDirectoryList) => Promise<boolean>} [options.waitForBootChain]
 * @param {(directories: import('./users.js').UserDirectoryList) => Promise<void>} [options.onTagDefinitionsChanged]
 * @param {() => void} [options.onChanged]
 * @param {(directories: import('./users.js').UserDirectoryList, payload: import('./character-metadata-db.js').TagMoveFailedPayload) => void} [options.onTagMoveFailed]
 * @param {(directories: import('./users.js').UserDirectoryList) => void} [options.onTagOrderSettled]
 * @param {(directories: import('./users.js').UserDirectoryList) => void} [options.onTagChangesLogged]
 * @param {(directories: import('./users.js').UserDirectoryList) => void} [options.onChatStatsMayBeQueued]
 */
export function createMetadataMigrationCoordinator({
    spawnWorker = spawnMigrationWorker,
    waitForBootChain = waitForMetadataBootChain,
    onTagDefinitionsChanged = clearTagCache,
    onChanged = () => characterChangeEmitter.emit('change'),
    onTagMoveFailed = (directories, payload) => reportTagMoveFailed(directories.root, payload),
    onTagOrderSettled = directories => reportTagOrderSettled(directories.root),
    onTagChangesLogged = directories => reportTagChanges(directories.root),
    onChatStatsMayBeQueued = kickChatStatsReconcile,
} = {}) {
    /** @type {Map<string, WorkerEntry>} */
    const entries = new Map();
    /** @type {Map<string, Promise<void>>} */
    const starts = new Map();
    /** @type {Map<string, StoreRuns>} */
    const storeRuns = new Map();
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
                // After the cache is cleared, so a client that asks on this isn't answered from the old cache.
                if (msg.tagChangesLogged) onTagChangesLogged(directories);
                if (msg.changed) onChanged();
                onChatStatsMayBeQueued(directories);
                return;
            }
            case 'tag-move-failed': {
                onTagMoveFailed(directories, msg.payload);
                return;
            }
            case 'tag-order-settled': {
                // First, so a client that re-reads the tags on this message isn't answered from the old cache.
                await onTagDefinitionsChanged(directories);
                onTagOrderSettled(directories);
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
     * @param {string[]} passes In MIGRATION_PASSES order.
     * @param {boolean} boot
     * @returns {Promise<void>} Settles once the store's worker has exited (at once when none was started).
     */
    async function run(directories, passes, boot) {
        if (!(await waitForBootChain(directories))) {
            console.error(color.red(`[metadata-migrations] Not running ${passes.join(', ')} for ${directories.root}: its metadata boot chain did not complete.`));
            return;
        }
        if (disposed) return;

        const worker = spawnWorker({ directories, configPath: getConfigFilePath(), passes, boot });
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
        onChatStatsMayBeQueued(directories);
    }

    /** @returns {QueuedRun} */
    function newQueuedRun() {
        /** @type {() => void} */
        let settle = () => {};
        const done = new Promise(resolve => { settle = resolve; });
        return { passes: new Set(), boot: false, done: /** @type {Promise<void>} */ (done), settle };
    }

    /**
     * @param {import('./users.js').UserDirectoryList} directories
     * @param {StoreRuns} runs
     */
    async function drain(directories, runs) {
        while (runs.next) {
            const queued = runs.next;
            runs.next = null;
            runs.current = queued;
            try {
                await run(directories, MIGRATION_PASSES.filter(name => queued.passes.has(name)), queued.boot);
            } catch (err) {
                console.error(color.red(`[metadata-migrations] migration run for ${directories.root} failed: ${err?.message ?? err}`));
            } finally {
                runs.current = null;
                queued.settle();
            }
        }
    }

    /**
     * Queues `passes` for the store's next run, starting it now when no run is going.
     * @param {import('./users.js').UserDirectoryList} directories
     * @param {Iterable<string>} passes
     * @param {boolean} boot
     * @returns {Promise<void>} Settles once the run the passes joined has finished.
     */
    function schedule(directories, passes, boot) {
        let runs = storeRuns.get(directories.root);
        if (!runs) {
            runs = { current: null, next: null };
            storeRuns.set(directories.root, runs);
        }
        const idle = !runs.current && !runs.next;
        runs.next ??= newQueuedRun();
        for (const name of passes) runs.next.passes.add(name);
        if (boot) runs.next.boot = true;
        const done = runs.next.done;
        if (idle) void drain(directories, runs);
        return done;
    }

    return {
        /**
         * Starts the store's migration worker once its boot chain has finished. One per store: a second call
         * returns the first one's promise. Starts nothing in read-only mode.
         * @param {import('./users.js').UserDirectoryList} directories
         * @returns {Promise<void>} Settles once the store's worker has exited and its messages are handled.
         */
        start(directories) {
            if (isReadOnlyMode()) return Promise.resolve();
            let started = starts.get(directories.root);
            if (!started) {
                started = schedule(directories, MIGRATION_PASSES, true);
                starts.set(directories.root, started);
            }
            return started;
        },

        /**
         * Runs one migration pass for the store on demand: now when no run is going for the store, otherwise once
         * more after that run, with every request made meanwhile joining that one run. Runs nothing in read-only
         * mode or after dispose().
         * @param {import('./users.js').UserDirectoryList} directories
         * @param {typeof MIGRATION_PASSES[number]} name
         * @returns {Promise<void>} Settles once the run that includes this request has finished.
         */
        request(directories, name) {
            if (!MIGRATION_PASSES.includes(name)) return Promise.reject(new Error(`Not a metadata migration pass: ${name}`));
            if (isReadOnlyMode() || disposed) return Promise.resolve();
            return schedule(directories, [name], false);
        },

        /**
         * @param {import('./users.js').UserDirectoryList} directories
         * @returns {Promise<void>} Settles once the store has no run going or queued (at once when it has none now).
         */
        idle(directories) {
            const runs = storeRuns.get(directories.root);
            return (runs?.next ?? runs?.current)?.done ?? Promise.resolve();
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

/**
 * Runs one migration pass for the store while the server is up (see the coordinator's request()).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {typeof MIGRATION_PASSES[number]} name
 */
export function requestMetadataMigrationPass(directories, name) {
    return metadataMigrationCoordinator.request(directories, name);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>} Settles once the store has no migration run going or queued.
 */
export function whenMetadataMigrationsIdle(directories) {
    return metadataMigrationCoordinator.idle(directories);
}

export function disposeMetadataMigrationWorkers() {
    return metadataMigrationCoordinator.dispose();
}
