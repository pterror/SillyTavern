import { getRequestHeaders } from './request-headers.js';

/** @type {Set<string>} */
const active = new Set();
/** @type {Map<string, Promise<StopResult|null>>} */
const stops = new Map();
/** @type {string|null} */
let streamId = null;

/**
 * @typedef {object} StopResult
 * @property {'stopped'|'finished'|'stopping'|'unknown'} state
 * @property {string|null} [mes]
 * @property {string|null} [node_id]
 * @property {Record<string, any>|null} [extra]
 */

function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * @returns {string}
 */
export function beginServerGeneration() {
    const id = newId();
    active.add(id);
    return id;
}

/**
 * The generation's reply comes as a stream: its stop result is taken when the stream ends.
 * @param {string} id
 */
export function streamServerGeneration(id) {
    streamId = id;
}

/**
 * @param {string} id
 */
export function endServerGeneration(id) {
    active.delete(id);
}

export function stopServerGenerations() {
    for (const id of active) {
        active.delete(id);
        stops.set(id, fetch(`/api/generation/generate/stop/${encodeURIComponent(id)}`, {
            method: 'POST',
            headers: getRequestHeaders(),
            keepalive: true,
        }).then(response => response.ok ? response.json() : (response.status === 404 ? { state: 'unknown' } : null))
            .catch(() => null));
    }
}

/**
 * @param {string} id
 * @returns {Promise<StopResult|null>|undefined}
 */
export function takeStopResult(id) {
    const stop = stops.get(id);
    stops.delete(id);
    return stop;
}

/**
 * @returns {Promise<StopResult|null|undefined>}
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
