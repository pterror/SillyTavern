import { localforage } from '../lib.js';
import { getCurrentUserHandle } from './user.js';

/**
 * Client-side delta cache for character data (see getCharacters() in script.js).
 *
 * The server's `/api/characters/all` returns every character's full data on every call, which is fine for a
 * small library but doesn't scale - a multi-tens-of-MB response on every single boot, regardless of whether
 * anything actually changed since last time. `/api/characters/manifest` is the cheap counterpart: just
 * `[{ avatar, mtime }, ...]` for the whole library, no PNG parsing. This module keeps a per-avatar IndexedDB
 * cache (already-processed, i.e. post-DOMPurify/chat-default, character objects keyed by avatar + the mtime
 * they were fetched at) so getCharacters() can diff the manifest against it and only ask the server
 * (`/api/characters/batch`) for characters that are new or whose mtime moved, instead of re-fetching and
 * re-processing the entire library every boot.
 *
 * One IndexedDB database per user handle (matches the multi-user server model - each user has their own
 * character library on disk, so caches must not bleed between accounts sharing a browser).
 */

/** @type {Map<string, LocalForage>} */
const storesByHandle = new Map();

/**
 * @returns {LocalForage} The character cache store for the currently logged-in user.
 */
function getCharacterCacheStore() {
    const handle = getCurrentUserHandle();
    let store = storesByHandle.get(handle);
    if (!store) {
        store = localforage.createInstance({ name: `SillyTavern_CharacterCache_${handle}` });
        storesByHandle.set(handle, store);
    }
    return store;
}

/**
 * Diffs a freshly-fetched manifest against what's currently cached.
 * @param {{avatar: string, mtime: number}[]} manifest Current server-side manifest.
 * @returns {Promise<{ toFetch: string[], cached: Map<string, object> }>} `toFetch` is every avatar that's new
 * or whose cached mtime doesn't match the manifest (or isn't cached at all); `cached` maps every avatar whose
 * cached copy is still fresh to its already-processed character object.
 */
export async function diffCharacterManifest(manifest) {
    const store = getCharacterCacheStore();
    const toFetch = [];
    const cached = new Map();

    await Promise.all(manifest.map(async ({ avatar, mtime }) => {
        try {
            const record = await store.getItem(avatar);
            if (record && record.mtime === mtime && record.character) {
                cached.set(avatar, record.character);
            } else {
                toFetch.push(avatar);
            }
        } catch (error) {
            console.error(`Failed to read cached character data for ${avatar}:`, error);
            toFetch.push(avatar);
        }
    }));

    return { toFetch, cached };
}

/**
 * Persists freshly-fetched characters into the cache, keyed by avatar. Callers should pass already fully
 * processed character objects (DOMPurify-sanitized name, defaulted chat, etc. - i.e. exactly what would've been
 * assigned into the `characters` array before this cache existed), since diffCharacterManifest() returns cache
 * hits as-is with no further processing applied on the next boot.
 * @param {{avatar: string, mtime: number, character: object}[]} entries
 */
export async function saveCachedCharacters(entries) {
    const store = getCharacterCacheStore();
    await Promise.all(entries.map(({ avatar, mtime, character }) =>
        store.setItem(avatar, { mtime, character }).catch(error =>
            console.error(`Failed to cache character data for ${avatar}:`, error))));
}

/**
 * Removes cached entries for avatars no longer present in the current manifest (deleted/renamed characters).
 * The returned `characters` list only ever derives from the live manifest, so a stale entry left behind
 * couldn't resurface into it - this is purely so the cache doesn't grow forever.
 * @param {Set<string>} validAvatars Every avatar currently in the manifest.
 */
export async function pruneCharacterCache(validAvatars) {
    const store = getCharacterCacheStore();
    try {
        const keys = await store.keys();
        await Promise.all(keys
            .filter(key => !validAvatars.has(key))
            .map(key => store.removeItem(key).catch(error =>
                console.error(`Failed to prune cached character data for ${key}:`, error))));
    } catch (error) {
        console.error('Failed to prune character cache:', error);
    }
}

/**
 * Drops the entire character cache for the current user. Used as a fallback when the manifest/batch delta path
 * fails or looks inconsistent, so the next successful getCharacters() call starts from a clean slate instead of
 * potentially mixing in stale cached entries.
 */
export async function clearCharacterCache() {
    const store = getCharacterCacheStore();
    try {
        await store.clear();
    } catch (error) {
        console.error('Failed to clear character cache:', error);
    }
}
