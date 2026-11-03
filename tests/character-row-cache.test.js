import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { installBrowserStorage } from './util/browser-storage.js';

/** @type {Map<string, Map<string, any>>} */
const localforageStores = new Map();

function createFakeLocalforageInstance({ name }) {
    let records = localforageStores.get(name);
    if (!records) {
        records = new Map();
        localforageStores.set(name, records);
    }
    return {
        getItem: async key => (records.has(key) ? structuredClone(records.get(key)) : null),
        setItem: async (key, value) => { records.set(key, structuredClone(value)); return value; },
        removeItem: async key => { records.delete(key); },
        iterate: async (fn) => {
            for (const [key, value] of [...records]) {
                const result = fn(structuredClone(value), key);
                if (result !== undefined) return result;
            }
        },
    };
}

jest.unstable_mockModule('../public/lib.js', () => ({ localforage: { createInstance: createFakeLocalforageInstance } }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'row-cache-test-user' }));

/** @type {typeof import('../public/scripts/character-cache.js')} */
let cache;
/** @type {() => void} */
let restore = () => {};

const rowsStore = () => localforageStores.get('SillyTavern_ListRows_row-cache-test-user') ?? new Map();
const metaStore = () => localforageStores.get('SillyTavern_ListRowsMeta_row-cache-test-user') ?? new Map();

/**
 * @param {number | undefined} quota
 */
async function freshSession(quota) {
    restore();
    restore = installBrowserStorage({ quota });
    jest.resetModules();
    cache = await import('../public/scripts/character-cache.js');
}

/**
 * @param {number} i
 * @param {number} [bytes]
 */
function entry(i, bytes = 100) {
    return { key: cache.characterRowKey({ id: `c${i}.png`, version: i, tagIdsHash: 0 }), row: { name: `c${i}`, data: { creator_notes: 'x'.repeat(bytes) } } };
}

const storedBytes = () => [...metaStore()].filter(([key]) => key !== '__total__').reduce((sum, [, item]) => sum + item.size, 0);

beforeEach(() => {
    for (const records of localforageStores.values()) records.clear();
});

afterEach(() => {
    restore();
    restore = () => {};
});

describe('the shown-row cache', () => {
    test('where the browser reports no storage quota, rows are kept in memory only, within a fixed budget, least recently used out first', async () => {
        await freshSession(undefined);
        const mib = 1024 * 1024;
        const rowsInBudget = Math.floor(cache.MEMORY_ROW_CACHE_BYTES / mib);
        await cache.keepRows([entry(0, mib)]);
        await cache.keepRows([entry(1, mib)]);
        const shown = (await cache.readRows([entry(0).key])).get(entry(0).key);
        expect(shown?.name).toBe('c0');
        shown.name = 'changed by the caller';
        expect((await cache.readRows([entry(0).key])).get(entry(0).key)?.name).toBe('c0');

        for (let i = 2; i < rowsInBudget + 4; i++) await cache.keepRows([entry(i, mib)]);

        expect(rowsStore().size).toBe(0);
        expect(metaStore().size).toBe(0);
        const kept = await cache.readRows(Array.from({ length: rowsInBudget + 4 }, (_, i) => entry(i).key));
        expect(kept.has(entry(1).key)).toBe(false);
        expect(kept.has(entry(rowsInBudget + 3).key)).toBe(true);
        const bytes = [...kept.values()].reduce((sum, row) => sum + JSON.stringify(row).length, 0);
        expect(bytes).toBeLessThanOrEqual(cache.MEMORY_ROW_CACHE_BYTES);
        expect(kept.size).toBeLessThan(rowsInBudget + 4);
    });

    test('a kept row comes back by its content key, and a changed character is another key', async () => {
        await freshSession(1e9);
        await cache.keepRows([entry(1)]);
        expect((await cache.readRows([entry(1).key])).get(entry(1).key)?.name).toBe('c1');
        expect(cache.characterRowKey({ id: 'c1.png', version: 2, tagIdsHash: 0 })).not.toBe(entry(1).key);
        expect(cache.characterRowKey({ id: 'c1.png', version: 1, tagIdsHash: 9 })).not.toBe(entry(1).key);
        expect(cache.characterRowKey({ id: 'c1.png', version: null, tagIdsHash: 0 })).toBeNull();
        expect(cache.groupRowKey({ id: 'g', favHash: 1, tagIdsHash: 2, contentHash: 3 })).not.toBe(cache.groupRowKey({ id: 'g', favHash: 1, tagIdsHash: 2, contentHash: 4 }));
    });

    test('never holds more than its share of the reported quota, dropping the least recently used first', async () => {
        const quota = 5000;
        const tick = () => new Promise(resolve => setTimeout(resolve, 3));
        await freshSession(quota);
        const budget = Math.floor(quota * cache.ROW_CACHE_QUOTA_SHARE);
        await cache.keepRows([entry(0)]);
        await tick();
        await cache.keepRows([entry(1)]);
        await tick();
        await freshSession(quota);
        await cache.readRows([entry(0).key]);
        await tick();
        let evicted = 0;
        for (let i = 2; i < 40; i++) {
            await cache.keepRows([entry(i)]);
            await tick();
            expect(storedBytes()).toBeLessThanOrEqual(budget);
            expect(metaStore().get('__total__')).toBe(storedBytes());
            const byRecency = [1, 0, ...Array.from({ length: i - 1 }, (_, n) => n + 2)];
            const missing = byRecency.filter(n => !rowsStore().has(entry(n).key));
            expect(missing).toEqual(byRecency.slice(0, missing.length));
            evicted = Math.max(evicted, missing.length);
        }
        expect(evicted).toBeGreaterThan(1);
        expect(rowsStore().has(entry(39).key)).toBe(true);
    });

    test('the share follows the quota, not the number of rows', async () => {
        await freshSession(1e9);
        for (let i = 0; i < 200; i++) await cache.keepRows([entry(i)]);
        expect(rowsStore().size).toBe(200);
        await freshSession(20_000);
        for (let i = 200; i < 400; i++) await cache.keepRows([entry(i)]);
        expect(storedBytes()).toBeLessThanOrEqual(Math.floor(20_000 * cache.ROW_CACHE_QUOTA_SHARE));
    });
});
