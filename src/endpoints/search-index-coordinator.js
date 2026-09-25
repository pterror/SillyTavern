import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import { characterChangeEmitter } from '../character-metadata-db.js';
import { color, getConfigFilePath } from '../util.js';
import { getTantivyModule } from './tantivy-engine.js';

const WORKER_MODULE_PATH = fileURLToPath(new URL('./search-index-worker.js', import.meta.url));
const TARGETS = /** @type {const} */ (['characters', 'groups']);
const DISPOSE_TIMEOUT_MS = 10000;

/**
 * @typedef {'characters' | 'groups'} SearchIndexTarget
 * @typedef {{ index: any, schema: any }} SearchIndexReader
 * @typedef {{ postMessage(msg: object): void, on(event: string, listener: (...args: any[]) => void): any, terminate(): Promise<number> | void, unref?(): void }} SearchIndexWorker
 * @typedef {{ promise: Promise<any>, resolve: (value?: any) => void, reject: (reason?: any) => void }} Deferred
 * @typedef {{
 *   worker: SearchIndexWorker,
 *   targets: Record<SearchIndexTarget, { ready: Deferred, reader: SearchIndexReader | null }>,
 *   pending: Map<number, Deferred>,
 *   exited: Deferred,
 *   disposing: boolean,
 * }} WorkerEntry
 */

/** @param {object} workerData */
function spawnSearchIndexWorker(workerData) {
    return new Worker(WORKER_MODULE_PATH, { workerData });
}

/**
 * The request-process side of the search indexes. Per handle it runs one search-index-worker.js, which owns the
 * only writer of that user's indexes and does every build and catch-up. Searches run here, on read-only readers
 * that reload when the worker reports a commit, so nothing on the request path waits for index maintenance -
 * only a handle's very first request waits for its index to be openable.
 * @param {object} [options]
 * @param {(workerData: object) => SearchIndexWorker} [options.spawnWorker]
 * @param {(dir: string) => SearchIndexReader} [options.openIndex] Defaults to tantivy's Index.open().
 * @param {(msg: object) => void} [options.onCharactersCommitted] Gets the worker's 'committed' message.
 * Defaults to emitting characterChangeEmitter's 'change'.
 * @param {object} [options.workerOptions] Extra workerData (tickIntervalMs, tickBudgetMs).
 */
export function createSearchIndexCoordinator({
    spawnWorker = spawnSearchIndexWorker,
    openIndex = undefined,
    onCharactersCommitted = () => characterChangeEmitter.emit('change'),
    workerOptions = {},
} = {}) {
    /** @type {Map<string, WorkerEntry>} */
    const entries = new Map();
    let nextRequestId = 0;
    /** @type {any} */
    let tantivy = null;

    /** @param {string} dir */
    function open(dir) {
        if (openIndex) return openIndex(dir);
        const index = tantivy.Index.open(dir);
        return { index, schema: index.schema };
    }

    /** @returns {Deferred} */
    function deferred() {
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        // A rejection nobody awaits yet must not surface as an unhandled one.
        promise.catch(() => { });
        return { promise, resolve, reject };
    }

    /**
     * @param {string} handle
     * @param {import('../users.js').UserDirectoryList} directories
     * @returns {WorkerEntry}
     */
    function spawn(handle, directories) {
        const worker = spawnWorker({ handle, directories, configPath: getConfigFilePath(), ...workerOptions });
        worker.unref?.();
        const targets = /** @type {WorkerEntry['targets']} */ (
            Object.fromEntries(TARGETS.map(target => [target, { ready: deferred(), reader: null }])));
        /** @type {WorkerEntry} */
        const entry = {
            worker,
            targets,
            pending: new Map(),
            exited: deferred(),
            disposing: false,
        };

        worker.on('message', (msg) => {
            try {
                handleMessage(entry, msg);
            } catch (err) {
                console.error(color.red(`[search] handling a search index worker message failed: ${err.message}`));
            }
        });
        worker.on('error', (err) => {
            console.error(color.red(`[search] search index worker for ${handle} failed: ${err?.message ?? err}`));
        });
        worker.on('exit', (code) => {
            if (!entry.disposing) {
                console.error(color.red(`[search] search index worker for ${handle} exited (code ${code})`));
            }
            if (entries.get(handle) === entry) {
                entries.delete(handle);
            }
            const gone = new Error('search index worker exited');
            for (const target of TARGETS) {
                entry.targets[target].ready.reject(gone);
            }
            for (const request of entry.pending.values()) {
                request.reject(gone);
            }
            entry.pending.clear();
            entry.exited.resolve();
        });

        entries.set(handle, entry);
        return entry;
    }

    function handleMessage(entry, msg) {
        switch (msg?.type) {
            case 'ready': {
                const target = entry.targets[msg.target];
                if (msg.error) {
                    target.ready.reject(new Error(msg.error));
                    return;
                }
                try {
                    target.reader = msg.dir ? open(msg.dir) : null;
                    target.ready.resolve(target.reader);
                } catch (err) {
                    target.ready.reject(err);
                }
                return;
            }
            case 'committed': {
                entry.targets[msg.target].reader?.index.reload();
                if (msg.target === 'characters') {
                    onCharactersCommitted(msg);
                }
                return;
            }
            case 'swapped': {
                entry.targets[msg.target].reader = open(msg.dir);
                return;
            }
            case 'reply': {
                const request = entry.pending.get(msg.id);
                entry.pending.delete(msg.id);
                request?.resolve(msg);
                return;
            }
            case 'error': {
                console.error(color.red(`[search] ${msg.message}`));
                return;
            }
        }
    }

    function request(entry, msg) {
        const id = ++nextRequestId;
        const reply = deferred();
        entry.pending.set(id, reply);
        entry.worker.postMessage({ ...msg, id });
        return reply.promise;
    }

    /**
     * @param {string} handle
     * @param {import('../users.js').UserDirectoryList} directories
     */
    async function getEntry(handle, directories) {
        if (!openIndex && !tantivy) {
            tantivy = await getTantivyModule();
        }
        // No await between the get and spawn()'s set, so concurrent first calls share one worker.
        return entries.get(handle) ?? spawn(handle, directories);
    }

    return {
        /**
         * The reader for a handle's index, once the worker has it openable. null when the index can't exist
         * (the metadata store is unavailable).
         * @param {string} handle
         * @param {import('../users.js').UserDirectoryList} directories
         * @param {SearchIndexTarget} target
         * @returns {Promise<SearchIndexReader | null>}
         */
        async getIndex(handle, directories, target) {
            const entry = await getEntry(handle, directories);
            await entry.targets[target].ready.promise;
            return entry.targets[target].reader;
        },

        /**
         * A full characters rebuild-and-swap in the handle's worker. Resolves once searches read the new index.
         * @returns {Promise<boolean>} false when the metadata store is unavailable.
         */
        async rebuild(handle, directories) {
            const entry = await getEntry(handle, directories);
            const reply = await request(entry, { type: 'rebuild' });
            if (reply.error) {
                throw new Error(reply.error);
            }
            return reply.ok;
        },

        /**
         * Stops the worker of `handle` (or of every handle): it finishes its current step, releases its writer's
         * lock and exits. Terminated if it hasn't exited within DISPOSE_TIMEOUT_MS.
         * @param {string} [handle]
         */
        async dispose(handle) {
            const handles = handle === undefined ? [...entries.keys()] : [handle];
            await Promise.all(handles.map(async (h) => {
                const entry = entries.get(h);
                if (!entry) return;
                entries.delete(h);
                entry.disposing = true;
                request(entry, { type: 'close' }).catch(() => { });
                let timer;
                const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve(true), DISPOSE_TIMEOUT_MS); });
                const outcome = await Promise.race([entry.exited.promise.then(() => false), timedOut]);
                clearTimeout(timer);
                if (outcome) {
                    await entry.worker.terminate();
                }
            }));
        },
    };
}

const searchIndexCoordinator = createSearchIndexCoordinator();

/**
 * @param {string} handle
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {SearchIndexTarget} target
 */
export function getSearchIndex(handle, directories, target) {
    return searchIndexCoordinator.getIndex(handle, directories, target);
}

/**
 * @param {string} handle
 * @param {import('../users.js').UserDirectoryList} directories
 */
export function rebuildSearchIndex(handle, directories) {
    return searchIndexCoordinator.rebuild(handle, directories);
}

/** @param {string} [handle] Every handle's worker when omitted. */
export function disposeSearchWorkers(handle) {
    return searchIndexCoordinator.dispose(handle);
}
