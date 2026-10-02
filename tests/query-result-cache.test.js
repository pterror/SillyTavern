import { describe, test, expect, jest, beforeEach } from '@jest/globals';

/** One fake localforage instance per name: a Map behind localforage's async API. */
const instances = new Map();
jest.unstable_mockModule('../public/lib.js', () => ({
    localforage: {
        createInstance: ({ name }) => {
            if (!instances.has(name)) {
                const data = new Map();
                instances.set(name, {
                    data,
                    getItem: async key => (data.has(key) ? structuredClone(data.get(key)) : null),
                    setItem: async (key, value) => { data.set(key, structuredClone(value)); return value; },
                    removeItem: async key => { data.delete(key); },
                });
            }
            return instances.get(name);
        },
    },
}));
const cache = await import('../public/scripts/query-result-cache.js');
cache.setQueryCacheUser('tester');

/** An entry whose JSON is about `kb` KiB. */
const entryOf = (kb, token = 't') => ({ hashRows: [{ id: 'x'.repeat(kb * 1024) }], token, seq: 1 });
const keys = () => [...(instances.get('SillyTavern_QueryCache_tester')?.data.keys() ?? [])].filter(key => key !== '__index__').sort();

describe('query result cache', () => {
    // The module keeps its store, so each test empties it rather than replacing it.
    beforeEach(() => instances.get('SillyTavern_QueryCache_tester')?.data.clear());

    test('a kept page is read back, and a missing one reads as null', async () => {
        await cache.writeQueryCache('a', entryOf(1, 'tok-a'));
        expect((await cache.readQueryCache('a'))?.token).toBe('tok-a');
        expect(await cache.readQueryCache('missing')).toBeNull();
    });

    test('past the size budget, the least recently used entries go first', async () => {
        for (const key of ['a', 'b', 'c']) {
            await cache.writeQueryCache(key, entryOf(1200));
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        // 'a' is used again, so 'b' is now the least recently used.
        await cache.readQueryCache('a');
        await new Promise(resolve => setTimeout(resolve, 5));
        await cache.writeQueryCache('d', entryOf(1200));
        expect(keys()).toEqual(['a', 'c', 'd']);
    });

    test('a pinned entry is never evicted, and is evictable again once its owner lets go', async () => {
        await cache.writeQueryCache('pinned', entryOf(1200));
        await cache.pinQueryCache('view-1', ['pinned']);
        expect(await cache.pinnedQueryCacheKeys('view-1')).toEqual(['pinned']);
        for (const key of ['b', 'c', 'd', 'e']) {
            await new Promise(resolve => setTimeout(resolve, 5));
            await cache.writeQueryCache(key, entryOf(1200));
        }
        expect(keys()).toContain('pinned');

        await cache.pinQueryCache('view-1', []);
        await new Promise(resolve => setTimeout(resolve, 5));
        await cache.writeQueryCache('f', entryOf(1200));
        expect(keys()).not.toContain('pinned');
    });

    test('an entry larger than the whole budget isn\'t kept', async () => {
        await cache.writeQueryCache('huge', entryOf(5 * 1024));
        expect(keys()).toEqual([]);
    });
});
