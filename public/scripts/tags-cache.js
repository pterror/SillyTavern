import { localforage } from '../lib.js';
import { getCurrentUserHandle } from './user.js';

/**
 * Client-side cache for tag *definitions* only (`tags` - name/color/folder_type/sort_order/...). See
 * loadTagsSettings() in tags.js.
 *
 * Tag *assignments* (what used to be `tag_map`) are no longer cacheable here: phase 3 of the character-data-
 * residency redesign moved assignments off tags.json entirely and onto per-user sqlite (character_tags/
 * group_tags rows), fetched at boot via a batched `POST /api/tags/for` over whatever characters/groups are
 * actually resident client-side (see seedTagMapForResidentEntities() in tags.js) - there's no single blob left to
 * key a cache entry by, and no reason to: that fetch already only asks for the ids currently in memory.
 *
 * Definitions are still a single small array with no per-item manifest the way characters have, so the same
 * whole-array "invalidate everything on any change" freshness signature is kept - just backed by `tags_rev`
 * (character-metadata-db.js's sha256 content hash of the definitions table) instead of tags.json's own mtime,
 * since tags.json is gone. Because `tags_rev` is derived from definition content, it only changes when a
 * definition is actually created, edited, or deleted - assignment-only operations (tag/untag) are transparent to
 * it, so the cache never invalidates spuriously. No two-counter split is needed to tell "a definition changed"
 * from "only an assignment changed" - the content hash inherently ignores assignment-only writes, which isn't
 * worth optimizing further for a payload this small.
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
 * @returns {Promise<{ hash: number, tags: object[], assignedTagIds?: string[] }|null>} The cached tag definitions, or null if nothing is
 * cached yet.
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
