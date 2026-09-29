import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import { characterChangeEmitter, getMetaValue } from '../character-metadata-db.js';
import { isReadOnlyMode } from '../read-only-mode.js';
import { color, getConfigFilePath } from '../util.js';
import { getTantivyModule } from './tantivy-engine.js';

const WORKER_MODULE_PATH = fileURLToPath(new URL('./search-index-worker.js', import.meta.url));
const TARGETS = /** @type {const} */ (['characters', 'groups']);
/** Each target's index dir under `<directories.root>/search-index`, as characters-search-index.js and
 * groups-search-index.js name it. Read-only mode opens these directly. */
const INDEX_DIR_NAMES = { characters: 'characters-tantivy', groups: 'groups-tantivy' };
const DISPOSE_TIMEOUT_MS = 10000;

/** The meta keys the characters index persists its cursors under (characters-search-index.js writes them). */
export const CHARACTERS_INDEX_SEQ_META_KEY = 'tantivy_char_index_seq';
export const CHARACTERS_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY = 'tantivy_char_index_tag_name_change_seq';
/** The meta key the groups index persists the groups version it was built from under (groups-search-index.js
 * writes it). */
export const GROUPS_INDEX_VERSION_META_KEY = 'tantivy_group_index_version';
const SEARCH_INDEX_UPDATED_INTERVAL_MS = 1000;

/**
 * @typedef {'characters' | 'groups'} SearchIndexTarget
 * @typedef {{ seq: number, tagNameSeq: number }} SearchIndexPosition How far the characters index has applied
 * the change log (`seq`) and the tag-rename log (`tagNameSeq`).
 * @typedef {{ version: number }} GroupsIndexPosition The groups version (getGroupsVersion()) the groups index was
 * built from.
 * @typedef {{ index: any, schema: any, position?: SearchIndexPosition | GroupsIndexPosition | null }} SearchIndexReader
 * `position` is the index's position as of what this reader shows: a SearchIndexPosition for the characters
 * reader, a GroupsIndexPosition for the groups reader; null or absent when it isn't known.
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
 * that reload when the worker reports a commit, so nothing on the request path waits for index maintenance.
 * Boot starts the worker of every handle whose index exists (start()); otherwise the first request spawns it,
 * and a request that arrives before its index is openable waits for that.
 * In read-only mode (read-only-mode.js) no worker is spawned: each target's existing index is opened for reading
 * on its first request and kept per handle, start() starts nothing, and rebuild() throws.
 *
 * A reader shows a new commit only when reload() is called on it (tantivy's Manual reload policy), which happens
 * here in the same step that sets its `position`, so a reader never shows more than its position says. The
 * position comes from the worker's messages; in read-only mode it's the persisted cursors (characters) or version
 * (groups), read before the index is opened (null when they can't be read).
 * @param {object} [options]
 * @param {(workerData: object) => SearchIndexWorker} [options.spawnWorker]
 * @param {(dir: string) => SearchIndexReader} [options.openIndex] Defaults to tantivy's Index.open().
 * @param {(handle: string, seq: number) => void} [options.onSearchIndexUpdated] Called when a commit or a
 * rebuild-and-swap changed a handle's characters index, with the change-log seq the index now covers. At most once
 * per SEARCH_INDEX_UPDATED_INTERVAL_MS per handle: the first change in a quiet period is passed on at once, later
 * ones in the interval are coalesced into one call at its end, with the latest seq. Defaults to emitting
 * characterChangeEmitter's 'search-index-updated' (handle, seq).
 * @param {object} [options.workerOptions] Extra workerData (tickIntervalMs, tickBudgetMs).
 */
export function createSearchIndexCoordinator({
    spawnWorker = spawnSearchIndexWorker,
    openIndex = undefined,
    onSearchIndexUpdated = (handle, seq) => characterChangeEmitter.emit('search-index-updated', handle, seq),
    workerOptions = {},
} = {}) {
    /** @type {Map<string, WorkerEntry>} */
    const entries = new Map();
    /**
     * Read-only mode's readers, per handle.
     * @type {Map<string, Partial<Record<SearchIndexTarget, SearchIndexReader>>>}
     */
    const readOnlyReaders = new Map();
    /**
     * Per handle, kept across worker respawns so the interval holds for the handle.
     * @type {Map<string, { lastSentAt: number, timer: NodeJS.Timeout | null, seq: number }>}
     */
    const indexUpdates = new Map();
    let nextRequestId = 0;
    /** @type {any} */
    let tantivy = null;

    /**
     * @param {string} handle
     * @param {number} seq
     */
    function searchIndexUpdated(handle, seq) {
        let state = indexUpdates.get(handle);
        if (!state) {
            state = { lastSentAt: -Infinity, timer: null, seq };
            indexUpdates.set(handle, state);
        }
        state.seq = seq;
        if (state.timer) return;
        const send = () => {
            state.timer = null;
            state.lastSentAt = Date.now();
            try {
                onSearchIndexUpdated(handle, state.seq);
            } catch (err) {
                console.error(color.red(`[search] search-index-updated for ${handle} failed: ${err.message}`));
            }
        };
        const wait = state.lastSentAt + SEARCH_INDEX_UPDATED_INTERVAL_MS - Date.now();
        if (wait <= 0) {
            send();
            return;
        }
        state.timer = setTimeout(send, wait);
        state.timer.unref?.();
    }

    /**
     * @param {string} dir
     * @returns {SearchIndexReader}
     */
    function open(dir) {
        if (openIndex) return openIndex(dir);
        const index = tantivy.Index.open(dir);
        // Only reload() shows a new commit, so what a reader shows moves only together with its position.
        index.configReader('Manual');
        return { index, schema: index.schema };
    }

    /**
     * The index position a worker message carries, or null when it carries none.
     * @param {any} msg
     * @returns {SearchIndexPosition | GroupsIndexPosition | null}
     */
    function positionOf(msg) {
        if (msg?.target === 'groups') {
            return Number.isFinite(msg?.version) ? { version: msg.version } : null;
        }
        return Number.isFinite(msg?.seq) && Number.isFinite(msg?.tagNameSeq) ? { seq: msg.seq, tagNameSeq: msg.tagNameSeq } : null;
    }

    /**
     * @param {string} dir
     * @param {SearchIndexPosition | GroupsIndexPosition | null} position
     * @returns {SearchIndexReader}
     */
    function openAt(dir, position) {
        const reader = open(dir);
        reader.position = position;
        return reader;
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
                handleMessage(handle, entry, msg);
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

    /**
     * @param {string} handle
     * @param {WorkerEntry} entry
     * @param {any} msg
     */
    function handleMessage(handle, entry, msg) {
        switch (msg?.type) {
            case 'ready': {
                const target = entry.targets[msg.target];
                if (msg.error) {
                    target.ready.reject(new Error(msg.error));
                    return;
                }
                try {
                    target.reader = msg.dir ? openAt(msg.dir, positionOf(msg)) : null;
                    target.ready.resolve(target.reader);
                } catch (err) {
                    target.ready.reject(err);
                }
                return;
            }
            case 'committed': {
                const reader = entry.targets[msg.target].reader;
                if (reader) {
                    reader.index.reload();
                    reader.position = positionOf(msg);
                }
                if (msg.target === 'characters') {
                    searchIndexUpdated(handle, msg.seq);
                }
                return;
            }
            case 'swapped': {
                entry.targets[msg.target].reader = openAt(msg.dir, positionOf(msg));
                if (msg.target === 'characters') {
                    searchIndexUpdated(handle, msg.seq);
                }
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
        await loadTantivy();
        // No await between the get and spawn()'s set, so concurrent first calls share one worker.
        return entries.get(handle) ?? spawn(handle, directories);
    }

    async function loadTantivy() {
        if (!openIndex && !tantivy) {
            tantivy = await getTantivyModule();
        }
    }

    /**
     * Read-only mode: the index's persisted position, or null when it can't be read.
     * @param {import('../users.js').UserDirectoryList} directories
     * @param {SearchIndexTarget} target
     * @returns {Promise<SearchIndexPosition | GroupsIndexPosition | null>}
     */
    async function readPersistedPosition(directories, target) {
        if (target === 'groups') {
            try {
                const version = await getMetaValue(directories, GROUPS_INDEX_VERSION_META_KEY);
                if (version === null) return null;
                const position = { version: Number(version) };
                return Number.isFinite(position.version) ? position : null;
            } catch (err) {
                console.error(color.red(`[search] reading the groups index's persisted version failed: ${err.message}`));
                return null;
            }
        }
        try {
            const seq = await getMetaValue(directories, CHARACTERS_INDEX_SEQ_META_KEY);
            if (seq === null) return null;
            // The index reads a missing tag-rename cursor as 0 (openPersisted()), so this does too.
            const tagNameSeq = await getMetaValue(directories, CHARACTERS_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY);
            const position = { seq: Number(seq), tagNameSeq: tagNameSeq === null ? 0 : Number(tagNameSeq) };
            return Number.isFinite(position.seq) && Number.isFinite(position.tagNameSeq) ? position : null;
        } catch (err) {
            console.error(color.red(`[search] reading the characters index's persisted cursors failed: ${err.message}`));
            return null;
        }
    }

    /**
     * Read-only mode: the handle's existing index for `target`, opened for reading on the first request. A
     * missing index dir throws, since nothing can build it read-only. The index's position is read before it's
     * opened, so the reader shows at least what the position says.
     * @param {string} handle
     * @param {import('../users.js').UserDirectoryList} directories
     * @param {SearchIndexTarget} target
     * @returns {Promise<SearchIndexReader>}
     */
    async function getReadOnlyIndex(handle, directories, target) {
        await loadTantivy();
        let readers = readOnlyReaders.get(handle);
        if (!readers) {
            readers = {};
            readOnlyReaders.set(handle, readers);
        }
        const opened = readers[target];
        if (opened) return opened;
        const position = await readPersistedPosition(directories, target);
        return readers[target] ??= openAt(path.join(directories.root, 'search-index', INDEX_DIR_NAMES[target]), position);
    }

    return {
        /**
         * Starts the handle's worker if it isn't running. Doesn't wait for its indexes: the readers open when the
         * worker reports each one ready. Starts nothing in read-only mode.
         * @param {string} handle
         * @param {import('../users.js').UserDirectoryList} directories
         */
        async start(handle, directories) {
            if (isReadOnlyMode()) return;
            await getEntry(handle, directories);
        },

        /**
         * The reader for a handle's index, once the worker has it openable. null when the index can't exist
         * (the metadata store is unavailable).
         * @param {string} handle
         * @param {import('../users.js').UserDirectoryList} directories
         * @param {SearchIndexTarget} target
         * @returns {Promise<SearchIndexReader | null>}
         */
        async getIndex(handle, directories, target) {
            if (isReadOnlyMode()) {
                return getReadOnlyIndex(handle, directories, target);
            }
            const entry = await getEntry(handle, directories);
            await entry.targets[target].ready.promise;
            return entry.targets[target].reader;
        },

        /**
         * A full characters rebuild-and-swap in the handle's worker. Resolves once searches read the new index.
         * Throws in read-only mode.
         * @returns {Promise<boolean>} false when the metadata store is unavailable.
         */
        async rebuild(handle, directories) {
            if (isReadOnlyMode()) {
                throw new Error('the search index can\'t be rebuilt in read-only mode');
            }
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
 */
export function startSearchWorker(handle, directories) {
    return searchIndexCoordinator.start(handle, directories);
}

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
