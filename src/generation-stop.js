import { randomUUID } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRY_TTL_MS = 10 * 60 * 1000;
const ENTRY_MAX = 200;
const STOP_WAIT_MS = 15000;

/**
 * @typedef {object} StopEntry
 * @property {string} id
 * @property {string|undefined} owner
 * @property {boolean} stopped
 * @property {Array<() => void>} flushHooks
 * @property {Array<() => void|Promise<void>>} aborts
 * @property {{mes: string, node_id: string, extra?: object}|null} persisted
 * @property {{pending: object, text: string, reason: string, warning: object}|null} [unsaved]
 * @property {boolean} done
 * @property {number} startedAt
 * @property {number} doneAt
 * @property {Promise<void>} settled
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
        persisted: null, unsaved: null, done: false, startedAt: Date.now(), doneAt: 0, settled, settle,
    };
    entries.set(id, entry);
    response.locals.generationStop = entry;
    if (!response.headersSent) response.setHeader('X-Generation-Id', id);
    return entry;
}

/**
 * @param {StopEntry|undefined} entry
 */
export function closeGenerationStop(entry) {
    if (!entry || entry.done) return;
    entry.done = true;
    entry.doneAt = Date.now();
    entry.settle();
}

/**
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
 * @param {import('express').Response} response
 */
export function stoppableController(response) {
    const controller = new AbortController();
    onGenerationStop(response, () => controller.abort());
    return controller;
}

/**
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
 * @param {import('express').Response} response
 * @param {() => void} fn
 */
export function onGenerationStopFlush(response, fn) {
    const entry = entryOf(response);
    if (!entry || entry.stopped) return;
    entry.flushHooks.push(fn);
}

/**
 * @param {StopEntry|undefined} entry
 * @param {{mes: string, node_id: string, extra?: object}|null} persisted
 */
export function recordGenerationPersisted(entry, persisted) {
    if (entry && persisted) entry.persisted = persisted;
}

/**
 * @param {string} id
 * @param {string|undefined} handle
 * @returns {Promise<{state: 'unknown'} | {state: 'stopped'|'finished'|'stopping', mes: string|null, node_id: string|null, extra: object|null}>}
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
    return { state, mes: entry.persisted?.mes ?? null, node_id: entry.persisted?.node_id ?? null, extra: entry.persisted?.extra ?? null };
}

/**
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
 * @param {string} id
 * @param {string|undefined} handle
 * @returns {StopEntry|undefined}
 */
export function generationEntryOf(id, handle) {
    const entry = entries.get(id);
    return entry && entry.owner === handle ? entry : undefined;
}
