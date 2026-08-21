import { localforage } from '../lib.js';
import { getCurrentUserHandle } from './user.js';

/**
 * Client-side cache for `{ tags, tag_map }` (see loadTagsSettings() in tags.js).
 *
 * Unlike characters, tags.json has no per-item identity that a manifest-and-diff approach (character-cache.js)
 * could act on - it's a single file holding the whole tags array and tag_map object, and a tag edit doesn't
 * correspond to one file's mtime the way a character edit does to one PNG's. Given that, and that tag edits are
 * expected to be far less frequent/voluminous than character edits, a single whole-file mtime is used as the
 * freshness signature instead: unchanged mtime means the cached `{ tags, tag_map }` is reused as-is and the
 * (potentially ~10MB+) `/api/tags/get` response is skipped entirely; any change re-fetches everything. This
 * "invalidate everything on any change" coarseness is the same tradeoff characters-search-index.js already
 * makes for its own freshness signature - it just wasn't an acceptable tradeoff for the *client's* character
 * boot fetch, which is why that one got the finer-grained per-avatar manifest instead.
 */

/** @type {Map<string, LocalForage>} */
const storesByHandle = new Map();

/**
 * @returns {LocalForage} The tags cache store for the currently logged-in user.
 */
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

/**
 * @returns {Promise<{ mtime: number, tags: object[], tag_map: object }|null>} The cached tags data, or null if
 * nothing is cached yet.
 */
export async function getCachedTags() {
    try {
        return await getTagsCacheStore().getItem(CACHE_KEY);
    } catch (error) {
        console.error('Failed to read cached tags data:', error);
        return null;
    }
}

/**
 * @param {number} mtime tags.json's mtime at the time `tags`/`tag_map` were fetched (see /api/tags/manifest).
 * @param {object[]} tags
 * @param {object} tag_map
 */
export async function setCachedTags(mtime, tags, tag_map) {
    try {
        await getTagsCacheStore().setItem(CACHE_KEY, { mtime, tags, tag_map });
    } catch (error) {
        console.error('Failed to cache tags data:', error);
    }
}
