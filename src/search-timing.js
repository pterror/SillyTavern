import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

import { getConfigValue } from './util.js';

/** @typedef {{ start: number, phases: Map<string, number> }} SearchTimingContext */

/** @type {AsyncLocalStorage<SearchTimingContext>} */
const store = new AsyncLocalStorage();

/** @type {boolean|null} */
let enabled = null;

function isEnabled() {
    if (enabled === null) {
        enabled = getConfigValue('performance.searchTiming', false, 'boolean') === true;
    }
    return enabled;
}

/**
 * @param {string} name
 * @param {number} ms
 */
export function addPhase(name, ms) {
    const ctx = store.getStore();
    if (!ctx) return;
    ctx.phases.set(name, (ctx.phases.get(name) ?? 0) + ms);
}

/**
 * @param {string} name
 */
export function markSinceStart(name) {
    const ctx = store.getStore();
    if (!ctx) return;
    addPhase(name, performance.now() - ctx.start);
}

/**
 * @template T
 * @param {string} name
 * @param {() => T} fn
 * @returns {T}
 */
export function timePhase(name, fn) {
    if (!store.getStore()) return fn();
    const t0 = performance.now();
    let result;
    try {
        result = fn();
    } catch (err) {
        addPhase(name, performance.now() - t0);
        throw err;
    }
    if (result && typeof (/** @type {any} */ (result)).then === 'function') {
        return /** @type {any} */ (result).then(
            (value) => { addPhase(name, performance.now() - t0); return value; },
            (err) => { addPhase(name, performance.now() - t0); throw err; },
        );
    }
    addPhase(name, performance.now() - t0);
    return result;
}

/**
 * @template T
 * @param {import('express').Response} response
 * @param {() => T} fn
 * @returns {T}
 */
export function withSearchTiming(response, fn) {
    if (!isEnabled()) return fn();

    /** @type {SearchTimingContext} */
    const ctx = { start: performance.now(), phases: new Map() };
    const originalSend = response.send;
    let patched = true;
    response.send = function (body) {
        if (!patched) return originalSend.call(this, body);
        patched = false;
        if (body !== undefined && body !== null && !Buffer.isBuffer(body) && typeof body !== 'string') {
            const t0 = performance.now();
            const s = JSON.stringify(body);
            ctx.phases.set('serialize', (ctx.phases.get('serialize') ?? 0) + (performance.now() - t0));
            if (!response.get('Content-Type')) {
                response.set('Content-Type', 'application/json; charset=utf-8');
            }
            body = s;
        }
        const handler = performance.now() - ctx.start;
        const entries = [...ctx.phases].map(([name, ms]) => `${name};dur=${ms.toFixed(3)}`);
        entries.push(`handler;dur=${handler.toFixed(3)}`);
        response.set('Server-Timing', entries.join(', '));
        return originalSend.call(this, body);
    };
    return store.run(ctx, fn);
}
