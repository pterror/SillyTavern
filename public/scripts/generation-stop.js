import { getRequestHeaders } from './request-headers.js';

/**
 * Explicit stop for generations the server keeps running after the page lets go of them.
 *
 * The server deliberately keeps a raw-action generation running when the page's connection drops, so
 * a reload can resume it. Aborting the page's own fetch therefore doesn't stop the backend. Each
 * generation request carries a page-chosen `X-Generation-Id`; stopping sends `POST
 * <base>/generate/stop/<id>`, which aborts the upstream request and answers with what the server
 * stored up to the stop.
 */

/** @type {Map<string, {base: string}>} */
const active = new Map();
/** @type {Map<string, Promise<StopResult|null>>} */
const stops = new Map();
/** @type {string|null} */
let streamId = null;

/**
 * @typedef {object} StopResult
 * @property {'stopped'|'finished'|'stopping'|'unknown'} state
 * @property {string|null} [mes] The stored message's whole text.
 * @property {string|null} [node_id] Where it is stored.
 */

/** A random v4 UUID; `crypto.randomUUID` needs a secure context, `getRandomValues` doesn't. */
function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Starts tracking a generation request. Send the returned id as the `X-Generation-Id` header.
 * @param {string} base The backend's route base, e.g. '/api/backends/text-completions'.
 * @param {{stream?: boolean}} [options] A streamed reply is settled by `takeStreamStopResult()` when it finishes.
 * @returns {string}
 */
export function beginServerGeneration(base, { stream = false } = {}) {
    const id = newId();
    active.set(id, { base });
    if (stream) streamId = id;
    return id;
}

/**
 * Stops tracking a request whose answer has fully arrived.
 * @param {string} id
 */
export function endServerGeneration(id) {
    active.delete(id);
}

/** Asks the server to stop every generation this page has running. */
export function stopServerGenerations() {
    for (const [id, { base }] of active) {
        active.delete(id);
        stops.set(id, fetch(`${base}/generate/stop/${encodeURIComponent(id)}`, {
            method: 'POST',
            headers: getRequestHeaders(),
            keepalive: true,
        }).then(response => response.ok ? response.json() : (response.status === 404 ? { state: 'unknown' } : null))
            .catch(() => null));
    }
}

/**
 * For the streamed reply that just finished: whether it was stopped, and if so what the server stored.
 * @returns {Promise<StopResult|null|undefined>} `undefined` if it wasn't stopped; `null` if the stop
 * couldn't be confirmed.
 */
export async function takeStreamStopResult() {
    const id = streamId;
    streamId = null;
    if (!id) return undefined;
    active.delete(id);
    const stop = stops.get(id);
    stops.delete(id);
    return stop ? await stop : undefined;
}
