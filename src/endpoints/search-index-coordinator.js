import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import { CHARACTERS_INDEX_SEQ_META_KEY, characterChangeEmitter, getMetaValue } from '../character-metadata-db.js';
import { isReadOnlyMode } from '../read-only-mode.js';
import { color, getConfigFilePath } from '../util.js';
import { getTantivyModule } from './tantivy-engine.js';

const WORKER_MODULE_PATH = fileURLToPath(new URL('./search-index-worker.js', import.meta.url));
const TARGETS = /** @type {const} */ (['characters', 'groups']);
/** Each target's index dir under `<directories.root>/search-index`, as characters-search-index.js and
 * groups-search-index.js name it. Read-only mode opens these directly. */
const INDEX_DIR_NAMES = { characters: 'characters-tantivy', groups: 'groups-tantivy' };
const DISPOSE_TIMEOUT_MS = 10000;

/** The meta keys the characters index persists its cursors under (characters-search-index.js writes them). The change log
 * position's key lives with the log, whose trimming holds at it. */
export { CHARACTERS_INDEX_SEQ_META_KEY };
export const CHARACTERS_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY = 'tantivy_char_index_tag_name_change_seq';
export const CHARACTERS_INDEX_RETRY_SEQ_META_KEY = 'tantivy_char_index_retry_seq';
export const CHARACTERS_INDEX_NAME_ORDER_SEQ_META_KEY = 'tantivy_char_index_name_order_seq';
/** The meta keys the groups index persists its position under (groups-search-index.js writes them). */
export const GROUPS_INDEX_VERSION_META_KEY = 'tantivy_group_index_version';
export const GROUPS_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY = 'tantivy_group_index_tag_name_change_seq';
const SEARCH_INDEX_UPDATED_INTERVAL_MS = 1000;

// Emitted on characterChangeEmitter as (handle, warning) when a card couldn't be indexed; warning is a
// CharacterIndexFailure (characters-search-index.js). The worker has already logged it.
export const CHARACTER_INDEX_FAILED_EVENT = 'character-index-failed';

/**
 * @typedef {'characters' | 'groups'} SearchIndexTarget
 * @typedef {{ seq: number, tagNameSeq: number, retrySeq: number, nameOrderSeq?: number }} SearchIndexPosition How far the
 * characters index has applied the change log (`seq`), the tag-rename log (`tagNameSeq`) and the name order log
 * (`nameOrderSeq`), and how many of its catch-ups changed it by retrying cards that had failed to index, without
 * moving a cursor (`retrySeq`).
 * @typedef {{ version: number, tagNameSeq: number }} GroupsIndexPosition How far the groups index has applied the
 * groups version log (`version`, a getGroupsVersion() value) and the tag-rename log (`tagNameSeq`).
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
 * position comes from the worker's messages; in read-only mode it's the index's persisted position, read before the
 * index is opened (null when it can't be read).
 * @param {object} [options]
 * @param {(workerData: object) => SearchIndexWorker} [options.spawnWorker]
 * @param {(dir: string) => SearchIndexReader} [options.openIndex] Defaults to tantivy's Index.open().
 * @param {(handle: string, seq: number | null, groupsVersion: number | null) => void} [options.onSearchIndexUpdated]
 * Called when a commit or a rebuild-and-swap changed a handle's characters or groups index. Every call carries both
 * readers' current positions as of the call: `seq`, the change-log seq the characters reader covers, and
 * `groupsVersion`, the groups version the groups reader covers; each is null
 * when that reader has no known position. At most once per SEARCH_INDEX_UPDATED_INTERVAL_MS per handle, characters
 * and groups together: the first change in a quiet period is passed on at once, later ones in the interval are
 * coalesced into one call at its end. Defaults to emitting characterChangeEmitter's 'search-index-updated'
 * (handle, seq, groupsVersion).
 * @param {(handle: string, warning: import('./characters-search-index.js').CharacterIndexFailure) => void} [options.onCharacterIndexFailed]
 * Called with each warning for a card of the handle's that couldn't be indexed. Defaults to emitting
 * characterChangeEmitter's CHARACTER_INDEX_FAILED_EVENT (handle, warning).
 * @param {object} [options.workerOptions] Extra workerData (tickIntervalMs, tickBudgetMs).
 */
export function createSearchIndexCoordinator({
    spawnWorker = spawnSearchIndexWorker,
    openIndex = undefined,
    onSearchIndexUpdated = (handle, seq, groupsVersion) => characterChangeEmitter.emit('search-index-updated', handle, seq, groupsVersion),
    onCharacterIndexFailed = (handle, warning) => characterChangeEmitter.emit(CHARACTER_INDEX_FAILED_EVENT, handle, warning),
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
     * @type {Map<string, { lastSentAt: number, timer: NodeJS.Timeout | null }>}
     */
    const indexUpdates = new Map();
    let nextRequestId = 0;
    /** @type {any} */
    let tantivy = null;

    /**
     * The handle's readers' current positions, as search-index-updated carries them: null for a reader that
     * doesn't exist or has no known position.
     * @param {string} handle
     * @returns {{ seq: number | null, groupsVersion: number | null }}
     */
    function currentPositions(handle) {
        const targets = entries.get(handle)?.targets;
        const characters = /** @type {SearchIndexPosition | null | undefined} */ (targets?.characters.reader?.position);
        const groups = /** @type {GroupsIndexPosition | null | undefined} */ (targets?.groups.reader?.position);
        return { seq: characters?.seq ?? null, groupsVersion: groups?.version ?? null };
    }

    /**
     * Announces that one of the handle's indexes changed. The positions are read when the call is made, so a
     * coalesced call carries the current ones.
     * @param {string} handle
     */
    function searchIndexUpdated(handle) {
        let state = indexUpdates.get(handle);
        if (!state) {
            state = { lastSentAt: -Infinity, timer: null };
            indexUpdates.set(handle, state);
        }
        if (state.timer) return;
        const send = () => {
            state.timer = null;
            state.lastSentAt = Date.now();
            try {
                const { seq, groupsVersion } = currentPositions(handle);
                onSearchIndexUpdated(handle, seq, groupsVersion);
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
            return Number.isFinite(msg?.version) && Number.isFinite(msg?.tagNameSeq) ? { version: msg.version, tagNameSeq: msg.tagNameSeq } : null;
        }
        return Number.isFinite(msg?.seq) && Number.isFinite(msg?.tagNameSeq) && Number.isFinite(msg?.retrySeq)
            ? { seq: msg.seq, tagNameSeq: msg.tagNameSeq, retrySeq: msg.retrySeq, ...(Number.isFinite(msg?.nameOrderSeq) ? { nameOrderSeq: msg.nameOrderSeq } : {}) }
            : null;
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
                searchIndexUpdated(handle);
                return;
            }
            case 'swapped': {
                entry.targets[msg.target].reader = openAt(msg.dir, positionOf(msg));
                searchIndexUpdated(handle);
                return;
            }
            case 'character-index-failed': {
                onCharacterIndexFailed(handle, msg.warning);
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
                // As for the characters index, a missing tag-rename cursor reads as 0.
                const tagNameSeq = await getMetaValue(directories, GROUPS_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY);
                const position = { version: Number(version), tagNameSeq: tagNameSeq === null ? 0 : Number(tagNameSeq) };
                return Number.isFinite(position.version) && Number.isFinite(position.tagNameSeq) ? position : null;
            } catch (err) {
                console.error(color.red(`[search] reading the groups index's persisted position failed: ${err.message}`));
                return null;
            }
        }
        try {
            const seq = await getMetaValue(directories, CHARACTERS_INDEX_SEQ_META_KEY);
            if (seq === null) return null;
            // The index reads a missing tag-rename cursor or retry counter as 0 (openPersisted()), so this does too.
            const tagNameSeq = await getMetaValue(directories, CHARACTERS_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY);
            const retrySeq = await getMetaValue(directories, CHARACTERS_INDEX_RETRY_SEQ_META_KEY);
            const nameOrderSeq = await getMetaValue(directories, CHARACTERS_INDEX_NAME_ORDER_SEQ_META_KEY);
            const position = {
                seq: Number(seq),
                tagNameSeq: tagNameSeq === null ? 0 : Number(tagNameSeq),
                retrySeq: retrySeq === null ? 0 : Number(retrySeq),
                nameOrderSeq: nameOrderSeq === null ? 0 : Number(nameOrderSeq),
            };
            return Number.isFinite(position.seq) && Number.isFinite(position.tagNameSeq) && Number.isFinite(position.retrySeq) ? position : null;
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
