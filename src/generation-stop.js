import { randomUUID } from 'node:crypto';

/**
 * An explicit stop for a generation the server keeps running after the page disconnects.
 *
 * A raw-action generation is resumable: the page dropping its connection (reload, network loss) must
 * not stop it, so the routes ignore a disconnect. A stop is a separate action, `POST
 * /generate/stop/:id`, naming the generation by the id the page sent as `X-Generation-Id` (or got
 * back in that header). It aborts the upstream request, the stream stops taking in upstream text, and
 * what is stored is exactly the text written to the page's stream up to the stop. The stop answers
 * with that stored text and its node id, so the page can show what the server has.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRY_TTL_MS = 10 * 60 * 1000;
const ENTRY_MAX = 200;
const STOP_WAIT_MS = 15000;

/**
 * @typedef {object} StopEntry
 * @property {string} id
 * @property {string|undefined} owner The user handle that started the generation.
 * @property {boolean} stopped
 * @property {Array<() => void>} flushHooks Run first on a stop, to write out content held back for coalescing.
 * @property {Array<() => void|Promise<void>>} aborts Abort the upstream request.
 * @property {{mes: string, node_id: string}|null} persisted What the reply was stored as, if it was.
 * @property {{pending: object, text: string, reason: string, warning: object}|null} [unsaved] A reply whose store
 *   failed, kept so `POST /api/generation/store/:id` can try again.
 * @property {boolean} done
 * @property {number} doneAt
 * @property {Promise<void>} settled Resolves once the route has finished with this generation.
 * @property {() => void} settle
 */

/** @type {Map<string, StopEntry>} */
const entries = new Map();

function evict() {
    const now = Date.now();
    for (const [id, entry] of entries) {
        if (entry.done && now - entry.doneAt > ENTRY_TTL_MS) entries.delete(id);
    }
    for (const [id, entry] of entries) {
        if (entries.size < ENTRY_MAX) break;
        if (entry.done) entries.delete(id);
    }
}

/**
 * Registers the generation this request starts, under the page's `X-Generation-Id` when it sent a
 * valid unused one, else a new id. Sets the response header and `response.locals.generationStop`.
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @returns {StopEntry}
 */
export function openGenerationStop(request, response) {
    evict();
    const asked = request.get?.('X-Generation-Id');
    const id = typeof asked === 'string' && UUID_RE.test(asked) && !entries.has(asked) ? asked : randomUUID();
    /** @type {() => void} */
    let settle = () => { };
    const settled = new Promise(resolve => { settle = () => resolve(undefined); });
    /** @type {StopEntry} */
    const entry = {
        id, owner: request.user?.profile?.handle, stopped: false, flushHooks: [], aborts: [],
        persisted: null, unsaved: null, done: false, doneAt: 0, settled, settle,
    };
    entries.set(id, entry);
    response.locals.generationStop = entry;
    if (!response.headersSent) response.setHeader('X-Generation-Id', id);
    return entry;
}

/**
 * Marks the generation finished: a stop waiting on it answers now. Idempotent.
 * @param {StopEntry|undefined} entry
 */
export function closeGenerationStop(entry) {
    if (!entry || entry.done) return;
    entry.done = true;
    entry.doneAt = Date.now();
    entry.settle();
}

/**
 * Wraps a generate route so every request gets a stop entry that is closed when the handler is done.
 * @param {(request: import('express').Request, response: import('express').Response) => Promise<any>} handler
 */
export function withGenerationStop(handler) {
    return async function (request, response) {
        const entry = openGenerationStop(request, response);
        try {
            return await handler(request, response);
        } finally {
            closeGenerationStop(entry);
        }
    };
}

/** @param {import('express').Response} response */
function entryOf(response) {
    return /** @type {StopEntry|undefined} */ (response?.locals?.generationStop);
}

/**
 * The id to use for this response's generation buffer and `X-Generation-Id` header.
 * @param {import('express').Response} response
 */
export function generationIdFor(response) {
    return entryOf(response)?.id ?? randomUUID();
}

/** @param {import('express').Response} response */
export function isGenerationStopped(response) {
    return !!entryOf(response)?.stopped;
}

/**
 * An AbortController whose `abort()` also runs when this response's generation is stopped.
 * @param {import('express').Response} response
 */
export function stoppableController(response) {
    const controller = new AbortController();
    onGenerationStop(response, () => controller.abort());
    return controller;
}

/**
 * Runs `fn` when this response's generation is stopped (at once if it already was).
 * @param {import('express').Response} response
 * @param {() => void|Promise<void>} fn
 */
export function onGenerationStop(response, fn) {
    const entry = entryOf(response);
    if (!entry) return;
    if (entry.stopped) {
        Promise.resolve().then(fn).catch(error => console.error('Generation stop hook failed:', error));
    } else {
        entry.aborts.push(fn);
    }
}

/**
 * Runs `fn` first when this response's generation is stopped, before the upstream request is aborted:
 * for writing out content a stream holds back to coalesce writes, so that what is stored is what was
 * sent.
 * @param {import('express').Response} response
 * @param {() => void} fn
 */
export function onGenerationStopFlush(response, fn) {
    const entry = entryOf(response);
    if (!entry || entry.stopped) return;
    entry.flushHooks.push(fn);
}

/**
 * Records what the reply was stored as, for a stop to answer with.
 * @param {StopEntry|undefined} entry
 * @param {{mes: string, node_id: string}|null} persisted
 */
export function recordGenerationPersisted(entry, persisted) {
    if (entry && persisted) entry.persisted = persisted;
}

/**
 * Stops a generation: flushes held-back content, aborts upstream, and waits for the route to finish.
 * @param {string} id
 * @param {string|undefined} handle The requesting user's handle; only the owner may stop it.
 * @returns {Promise<{state: 'unknown'} | {state: 'stopped'|'finished'|'stopping', mes: string|null, node_id: string|null}>}
 */
export async function stopGenerationById(id, handle) {
    const entry = entries.get(id);
    if (!entry || entry.owner !== handle) {
        return { state: 'unknown' };
    }
    if (!entry.done && !entry.stopped) {
        entry.stopped = true;
        for (const flush of entry.flushHooks.splice(0)) {
            try {
                flush();
            } catch (error) {
                console.error('Generation stop flush failed:', error);
            }
        }
        for (const abort of entry.aborts.splice(0)) {
            try {
                await abort();
            } catch (error) {
                console.error('Generation stop abort failed:', error);
            }
        }
    }
    let timer;
    const timedOut = await Promise.race([
        entry.settled.then(() => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(true), STOP_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    const state = timedOut ? 'stopping' : (entry.stopped ? 'stopped' : 'finished');
    return { state, mes: entry.persisted?.mes ?? null, node_id: entry.persisted?.node_id ?? null };
}

/**
 * Express handler for `POST /generate/stop/:id`.
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 */
export async function handleGenerationStop(request, response) {
    const result = await stopGenerationById(request.params.id, request.user?.profile?.handle);
    if (result.state === 'unknown') {
        return response.status(404).json(result);
    }
    return response.json(result);
}

/**
 * A generation's entry, if the given user started it.
 * @param {string} id
 * @param {string|undefined} handle
 * @returns {StopEntry|undefined}
 */
export function generationEntryOf(id, handle) {
    const entry = entries.get(id);
    return entry && entry.owner === handle ? entry : undefined;
}
