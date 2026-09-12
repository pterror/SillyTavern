import { localforage } from '../lib.js';
import { getCurrentUserHandle } from './user.js';

// Caches tag definitions only; `tags_rev` is a hash of the definitions table, so assignment-only
// writes (tag/untag) never invalidate this cache.

/** @type {Map<string, LocalForage>} */
const storesByHandle = new Map();

/** @returns {LocalForage} */
function getTagsCacheStore() {
    const handle = getCurrentUserHandle();
    let store = storesByHandle.get(handle);
    if (!store) {
        store = localforage.createInstance({ name: `SillyTavern_TagsCache_${handle}` });
        storesByHandle.set(handle, store);
    }
    return store;
}

const CACHE_KEY = 'tagsData';

/** @returns {Promise<{ hash: number, tags: object[], assignedTagIds?: string[] }|null>} */
export async function getCachedTags() {
    try {
        return await getTagsCacheStore().getItem(CACHE_KEY);
    } catch (error) {
        console.error('Failed to read cached tags data:', error);
        return null;
    }
}

/**
 * @param {number} hash `tags_rev` at the time `tags` was fetched (see /api/tags/manifest).
 * @param {object[]} tags
 */
export async function setCachedTags(hash, tags, assignedTagIds = []) {
    try {
        await getTagsCacheStore().setItem(CACHE_KEY, { hash, tags, assignedTagIds });
    } catch (error) {
        console.error('Failed to cache tags data:', error);
    }
}
