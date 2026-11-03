import { localforage } from '../lib.js';
import { getCurrentUserHandle } from './user.js';
import { normalizeTagIds } from './hash-utils.js';

export const ROW_CACHE_QUOTA_SHARE = 0.1;

export const MEMORY_ROW_CACHE_BYTES = 16 * 1024 * 1024;

const EVICT_TO = 0.9;
const TOTAL_KEY = '__total__';

/** @type {Map<string, { rows: LocalForage, meta: LocalForage }>} */
const storesByHandle = new Map();

/** @type {Set<string>} */
const touchedThisSession = new Set();

/** @type {Promise<number | null> | null} */
let budgetPromise = null;

/** @type {Map<string, { rows: Map<string, { row: Record<string, any>, size: number }>, total: number }>} */
const memoryByHandle = new Map();

function memory() {
    const handle = getCurrentUserHandle();
    let found = memoryByHandle.get(handle);
    if (!found) {
        found = { rows: new Map(), total: 0 };
        memoryByHandle.set(handle, found);
    }
    return found;
}

/**
 * @param {string[]} keys
 * @returns {Map<string, Record<string, any>>}
 */
function readMemory(keys) {
    const { rows } = memory();
    /** @type {Map<string, Record<string, any>>} */
    const found = new Map();
    for (const key of keys) {
        const item = rows.get(key);
        if (!item) continue;
        rows.delete(key);
        rows.set(key, item);
        found.set(key, structuredClone(item.row));
    }
    return found;
}

/**
 * @param {{ key: string, stored: Record<string, any>, size: number }[]} sized
 */
function keepMemory(sized) {
    const kept = memory();
    for (const { key, stored, size } of sized) {
        const before = kept.rows.get(key);
        if (before) {
            kept.rows.delete(key);
            kept.total -= before.size;
        }
        kept.rows.set(key, { row: stored, size });
        kept.total += size;
    }
    if (kept.total <= MEMORY_ROW_CACHE_BYTES) return;
    const target = Math.floor(MEMORY_ROW_CACHE_BYTES * EVICT_TO);
    for (const [key, item] of kept.rows) {
        if (kept.total <= target) break;
        kept.rows.delete(key);
        kept.total -= item.size;
    }
}

/**
 * @param {{ key: string, row: Record<string, any> }[]} entries
 */
function sizedRows(entries) {
    return entries.map(({ key, row }) => {
        const stored = structuredClone({ ...row, tag_ids: normalizeTagIds(row.tag_ids) });
        return { key, stored, size: JSON.stringify(stored).length };
    });
}

export function getCacheUserHandle() {
    return getCurrentUserHandle();
}

function stores() {
    const handle = getCurrentUserHandle();
    let found = storesByHandle.get(handle);
    if (!found) {
        found = {
            rows: localforage.createInstance({ name: `SillyTavern_ListRows_${handle}` }),
            meta: localforage.createInstance({ name: `SillyTavern_ListRowsMeta_${handle}` }),
        };
        storesByHandle.set(handle, found);
    }
    return found;
}

/**
 * @returns {Promise<number | null>}
 */
function budget() {
    budgetPromise ??= (async () => {
        try {
            if (typeof navigator?.storage?.estimate !== 'function' || typeof navigator?.locks?.request !== 'function') return null;
            const { quota } = await navigator.storage.estimate();
            return typeof quota === 'number' && quota > 0 ? Math.floor(quota * ROW_CACHE_QUOTA_SHARE) : null;
        } catch (error) {
            console.warn('[row-cache] the storage quota could not be read; shown rows are kept in memory only:', error);
            return null;
        }
    })();
    return budgetPromise;
}

/**
 * @template T
 * @param {() => T} job
 * @returns {Promise<T>}
 */
function locked(job) {
    return navigator.locks.request(`SillyTavern_ListRows_${getCurrentUserHandle()}`, job);
}

/**
 * @param {{ id: string, version: number | null, tagIdsHash: number }} hashRow
 * @returns {string | null}
 */
export function characterRowKey(hashRow) {
    return hashRow.version === null ? null : `c:${hashRow.version}:${hashRow.tagIdsHash}:${hashRow.id}`;
}

/**
 * @param {{ id: string, favHash: number, tagIdsHash: number, contentHash: number }} hashRow
 * @returns {string}
 */
export function groupRowKey(hashRow) {
    return `g:${hashRow.favHash}:${hashRow.tagIdsHash}:${hashRow.contentHash}:${hashRow.id}`;
}

/**
 * @param {string[]} keys
 * @returns {Promise<Map<string, Record<string, any>>>}
 */
export async function readRows(keys) {
    /** @type {Map<string, Record<string, any>>} */
    const found = new Map();
    if (keys.length === 0) return found;
    if (await budget() === null) return readMemory(keys);
    const { rows } = stores();
    await Promise.all(keys.map(async (key) => {
        try {
            const row = await rows.getItem(key);
            if (row && typeof row === 'object') found.set(key, /** @type {Record<string, any>} */ (row));
        } catch (error) {
            console.error(`[row-cache] could not read ${key}:`, error);
        }
    }));
    const untouched = [...found.keys()].filter(key => !touchedThisSession.has(key));
    if (untouched.length > 0) {
        for (const key of untouched) touchedThisSession.add(key);
        void touch(untouched).catch(error => console.warn('[row-cache] use not recorded:', error));
    }
    return found;
}

/**
 * @param {string[]} keys
 */
async function touch(keys) {
    const { meta } = stores();
    const now = Date.now();
    await locked(() => Promise.all(keys.map(async (key) => {
        const item = /** @type {{ size: number, used: number } | null} */ (await meta.getItem(key));
        if (item) await meta.setItem(key, { size: item.size, used: now });
    })));
}

/**
 * @param {{ key: string, row: Record<string, any> }[]} entries
 */
export async function keepRows(entries) {
    if (entries.length === 0) return;
    const limit = await budget();
    if (limit === null) {
        keepMemory(sizedRows(entries));
        return;
    }
    const { rows, meta } = stores();
    const now = Date.now();
    try {
        await locked(async () => {
            const sized = sizedRows(entries);
            const before = await Promise.all(sized.map(({ key }) => meta.getItem(key)));
            await Promise.all(sized.map(async ({ key, stored, size }) => {
                await rows.setItem(key, stored);
                await meta.setItem(key, { size, used: now });
                touchedThisSession.add(key);
            }));
            let total = Number(await meta.getItem(TOTAL_KEY)) || 0;
            sized.forEach(({ size }, i) => {
                total += size - (/** @type {{ size: number } | null} */ (before[i])?.size ?? 0);
            });
            if (total > limit) total = await evict(Math.floor(limit * EVICT_TO));
            await meta.setItem(TOTAL_KEY, total);
        });
    } catch (error) {
        console.error('[row-cache] rows not kept:', error);
    }
}

/**
 * @param {number} target
 * @returns {Promise<number>} The bytes kept afterwards.
 */
async function evict(target) {
    const { rows, meta } = stores();
    /** @type {{ key: string, size: number, used: number }[]} */
    const items = [];
    await meta.iterate((item, key) => {
        if (key === TOTAL_KEY) return;
        const { size, used } = /** @type {{ size: number, used: number }} */ (item);
        items.push({ key, size, used });
    });
    let total = items.reduce((sum, item) => sum + item.size, 0);
    items.sort((a, b) => a.used - b.used);
    for (const item of items) {
        if (total <= target) break;
        await rows.removeItem(item.key);
        await meta.removeItem(item.key);
        touchedThisSession.delete(item.key);
        total -= item.size;
    }
    return total;
}
