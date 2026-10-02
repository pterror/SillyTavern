import { localforage } from '../lib.js';

// The character list's query pages, kept in browser storage across reloads: per request, the ordered hash rows (ids
// and the hashes rows are resolved by) and the token to send back as `ifToken`. Rows themselves live in the
// character and group caches, never here. One size budget for every entry; the least recently used goes first,
// except entries a saved view pins.

/** Stored entries' JSON, in characters, kept at or under this. */
const BUDGET = 4 * 1024 * 1024;
const INDEX_KEY = '__index__';

/**
 * @typedef {object} QueryCacheEntry
 * @property {object[]} hashRows As `/query`'s hash mode answered them.
 * @property {string} token
 * @property {number} seq
 * @property {number|string} [total]
 * @property {number|string} [hidden]
 * @property {string} [searchBackend]
 * @property {string} [cursor]
 */

/** @typedef {Record<string, { size: number, used: number, pins: string[] }>} QueryCacheIndex */

/** @type {Map<string, LocalForage>} */
const storesByHandle = new Map();

/** The user whose entries are read and written; set by the caller, which knows the user. */
let currentHandle = '';

/** @param {string} handle */
export function setQueryCacheUser(handle) {
    currentHandle = handle;
}

function getStore() {
    const handle = currentHandle;
    let store = storesByHandle.get(handle);
    if (!store) {
        store = localforage.createInstance({ name: `SillyTavern_QueryCache_${handle}` });
        storesByHandle.set(handle, store);
    }
    return store;
}

/** Writes and evictions run one at a time, so the index never loses an update. */
let queue = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} job
 * @returns {Promise<T>}
 */
function serialized(job) {
    const run = queue.then(job, job);
    queue = run.then(() => {}, () => {});
    return run;
}

/** @returns {Promise<QueryCacheIndex>} */
async function readIndex() {
    const index = await getStore().getItem(INDEX_KEY);
    return index && typeof index === 'object' ? /** @type {QueryCacheIndex} */ (index) : {};
}

/**
 * The entry kept for a request, or null. Marks it used.
 * @param {string} key The request's signature.
 * @returns {Promise<QueryCacheEntry | null>}
 */
export async function readQueryCache(key) {
    try {
        const entry = /** @type {QueryCacheEntry | null} */ (await getStore().getItem(key));
        if (!entry || !Array.isArray(entry.hashRows) || typeof entry.token !== 'string') return null;
        void serialized(async () => {
            const index = await readIndex();
            if (!index[key]) return;
            index[key].used = Date.now();
            await getStore().setItem(INDEX_KEY, index);
        }).catch(() => {});
        return entry;
    } catch (error) {
        console.warn('[query-cache] read failed:', error);
        return null;
    }
}

/**
 * Keeps `entry` for a request, then evicts the least recently used unpinned entries past the budget.
 * @param {string} key
 * @param {QueryCacheEntry} entry
 */
export async function writeQueryCache(key, entry) {
    const size = JSON.stringify(entry).length;
    if (size > BUDGET) return;
    await serialized(async () => {
        const store = getStore();
        const index = await readIndex();
        await store.setItem(key, entry);
        index[key] = { size, used: Date.now(), pins: index[key]?.pins ?? [] };
        await evict(index);
        await store.setItem(INDEX_KEY, index);
    }).catch(error => console.warn('[query-cache] write failed:', error));
}

/**
 * Drops the least recently used unpinned entries until the kept ones fit the budget. Edits `index` in place.
 * @param {QueryCacheIndex} index
 */
async function evict(index) {
    let total = Object.values(index).reduce((sum, item) => sum + item.size, 0);
    if (total <= BUDGET) return;
    const unpinned = Object.entries(index).filter(([, item]) => item.pins.length === 0).sort((a, b) => a[1].used - b[1].used);
    for (const [key, item] of unpinned) {
        if (total <= BUDGET) break;
        await getStore().removeItem(key);
        delete index[key];
        total -= item.size;
    }
}

/**
 * Pins `keys` for `owner` (a saved view) and lets go of every key it pinned before that isn't among them. A pinned
 * entry is never evicted.
 * @param {string} owner
 * @param {string[]} keys
 */
export async function pinQueryCache(owner, keys) {
    const wanted = new Set(keys);
    await serialized(async () => {
        const index = await readIndex();
        let changed = false;
        for (const [key, item] of Object.entries(index)) {
            const has = item.pins.includes(owner);
            if (has && !wanted.has(key)) {
                item.pins = item.pins.filter(pin => pin !== owner);
                changed = true;
            } else if (!has && wanted.has(key)) {
                item.pins = [...item.pins, owner];
                changed = true;
            }
        }
        if (changed) {
            await evict(index);
            await getStore().setItem(INDEX_KEY, index);
        }
    }).catch(error => console.warn('[query-cache] pin failed:', error));
}

/**
 * Which entries `owner` pins.
 * @param {string} owner
 * @returns {Promise<string[]>}
 */
export async function pinnedQueryCacheKeys(owner) {
    try {
        const index = await readIndex();
        return Object.entries(index).filter(([, item]) => item.pins.includes(owner)).map(([key]) => key);
    } catch {
        return [];
    }
}
