import { parentPort, workerData } from 'node:worker_threads';

import { setConfigFilePath } from '../util.js';

/**
 * One user's search index worker (spawned by search-index-coordinator.js). Owns the only writer of the user's
 * characters and groups indexes, opens or builds them, then catches them up on a tick. Every step here runs one at
 * a time, in order: startup, ticks, and requests from the coordinator.
 *
 * Messages to the coordinator:
 *   { type: 'ready', target, dir }        target's index is openable at dir (dir null: it can't exist, the
 *                                         metadata store is unavailable); `error` instead when it failed.
 *   { type: 'committed', target, changed: true, seq, deletes, upserts, ms }   a tick committed changes.
 *   { type: 'swapped', target, dir, seq? } target's index was rebuilt and swapped in at dir; for characters, seq
 *                                         is the change-log seq it covers.
 *   { type: 'reply', id, ok, error? }     answer to a request; ok false without error: metadata store unavailable.
 *   { type: 'error', message }
 * Requests from the coordinator: { type: 'rebuild', id } (characters), { type: 'close', id }.
 */

const { directories, configPath, tickIntervalMs = 1000, tickBudgetMs = 1000 } = workerData;

// Must precede importing anything that reads config.
if (configPath) {
    setConfigFilePath(configPath);
}
const { getTantivyModule } = await import('./tantivy-engine.js');
const { createCharacterIndexMaintainer, formatCatchUpLine } = await import('./characters-search-index.js');
const { createGroupIndexMaintainer } = await import('./groups-search-index.js');
const { disposeMetadataStores } = await import('../character-metadata-db.js');

/** @param {object} msg */
const post = (msg) => parentPort.postMessage(msg);
const errorText = (err) => err?.message ?? String(err);

/** @type {Promise<unknown>} */
let queue = Promise.resolve();
/**
 * @template T
 * @param {() => Promise<T>} step
 * @returns {Promise<T>}
 */
function enqueue(step) {
    const run = queue.then(step);
    queue = run.catch(() => { });
    return run;
}

/** @type {ReturnType<typeof createCharacterIndexMaintainer> | null} */
let characters = null;
/** @type {ReturnType<typeof createGroupIndexMaintainer> | null} */
let groups = null;
let closing = false;
/** @type {NodeJS.Timeout | undefined} */
let tickTimer = undefined;

async function startup() {
    const tantivy = await getTantivyModule();
    if (!tantivy) {
        post({ type: 'ready', target: 'characters', error: 'the tantivy search backend is not usable on this install' });
        post({ type: 'ready', target: 'groups', error: 'the tantivy search backend is not usable on this install' });
        return false;
    }
    characters = createCharacterIndexMaintainer(directories, tantivy, { tickBudgetMs });
    groups = createGroupIndexMaintainer(directories, tantivy);

    const notReady = new Set(['characters', 'groups']);
    const ready = (target, dir) => {
        post({ type: 'ready', target, dir });
        notReady.delete(target);
    };
    try {
        // A persisted characters index is served before the groups build; a missing one is built last, since
        // on a large library that takes minutes.
        const persistedDir = await characters.openPersisted();
        if (persistedDir) ready('characters', persistedDir);
        ready('groups', await groups.build());
        if (notReady.has('characters')) ready('characters', await characters.rebuild());
        return true;
    } catch (err) {
        const error = `opening or building the search indexes failed: ${errorText(err)}`;
        post({ type: 'error', message: error });
        for (const target of notReady) {
            post({ type: 'ready', target, error });
        }
        return false;
    }
}

async function tick() {
    if (characters?.isOpen()) {
        try {
            const result = await characters.tick();
            if (!result) {
                // The metadata store is unavailable.
            } else if ('swapped' in result) {
                if (result.swapped) post({ type: 'swapped', target: 'characters', dir: result.swapped, seq: characters.seq() });
            } else if (result.changed) {
                console.log(formatCatchUpLine(result));
                post({ type: 'committed', target: 'characters', changed: true, seq: result.seq, deletes: result.deletes, upserts: result.upserts, ms: result.ms });
            }
        } catch (err) {
            post({ type: 'error', message: `character search index catch-up failed: ${errorText(err)}` });
        }
    }
    try {
        const dir = await groups?.tick();
        if (dir) post({ type: 'swapped', target: 'groups', dir });
    } catch (err) {
        post({ type: 'error', message: `group search index rebuild failed: ${errorText(err)}` });
    }
}

function scheduleTick() {
    if (closing) return;
    tickTimer = setTimeout(() => {
        enqueue(tick).finally(scheduleTick);
    }, tickIntervalMs);
}

async function shutdown() {
    closing = true;
    clearTimeout(tickTimer);
    try {
        characters?.close();
    } catch (err) {
        post({ type: 'error', message: `releasing the character search index writer failed: ${errorText(err)}` });
    }
    disposeMetadataStores();
}

parentPort.on('message', (msg) => {
    if (msg?.type === 'rebuild') {
        enqueue(async () => {
            if (closing || !characters) {
                post({ type: 'reply', id: msg.id, ok: false, error: 'the search index worker is not running' });
                return;
            }
            try {
                const dir = await characters.rebuild();
                if (dir) post({ type: 'swapped', target: 'characters', dir, seq: characters.seq() });
                post({ type: 'reply', id: msg.id, ok: Boolean(dir) });
            } catch (err) {
                post({ type: 'reply', id: msg.id, ok: false, error: errorText(err) });
            }
        });
    } else if (msg?.type === 'close') {
        closing = true;
        clearTimeout(tickTimer);
        enqueue(async () => {
            await shutdown();
            post({ type: 'reply', id: msg.id, ok: true });
            parentPort.close();
        });
    }
});

enqueue(async () => {
    if (await startup()) {
        scheduleTick();
        return;
    }
    await shutdown();
    parentPort.close();
});
