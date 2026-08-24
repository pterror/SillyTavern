import { localforage } from '../lib.js';
import { getCurrentUserHandle } from './user.js';

/**
 * Client-side residency cache for character data (see getCharacters()/fetchCharactersDelta() in script.js).
 *
 * The server's `/api/characters/all` returns every character's full data on every call, which is fine for a
 * small library but doesn't scale - a multi-tens-of-MB response on every single boot, regardless of whether
 * anything actually changed since last time. `POST /api/characters/changes` (character-metadata-db.js's
 * `getChangesSince()`) is the replacement for the old manifest-diff scheme this module used to implement: a
 * real per-item change feed (`{id, op: 'upsert'|'delete'}`) keyed off a revision counter the client just has to
 * remember and send back, not a `[{avatar, mtime}, ...]` snapshot of the *entire* library that the client had
 * to diff itself. That's why this cache no longer stores or compares a per-character `mtime` - the server
 * already tells us exactly which ids changed and how, so there's nothing left for the client to diff.
 *
 * One IndexedDB database per user handle (matches the multi-user server model - each user has their own
 * character library on disk, so caches must not bleed between accounts sharing a browser).
 */

/** @type {Map<string, LocalForage>} */
const storesByHandle = new Map();

// Reserved key for the change-feed revision cursor (see getCachedRev()/setCachedRev()) - never collides with a
// real avatar filename, which always ends in `.png`.
const REV_KEY = '__rev__';

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
 * The change-feed revision this cache was last synced up to - the `sinceRev` to send on the next
 * `POST /api/characters/changes` call. `0` (never synced) is a legitimate first-ever value: per
 * `getChangesSince()`'s own contract, `sinceRev: 0` returns the entire library as `op: 'upsert'` entries, which
 * is exactly what a cold cache needs.
 * @returns {Promise<number>}
 */
export async function getCachedRev() {
    const store = getCharacterCacheStore();
    try {
        const rev = await store.getItem(REV_KEY);
        return typeof rev === 'number' && Number.isFinite(rev) ? rev : 0;
    } catch (error) {
        console.error('Failed to read cached character revision:', error);
        return 0;
    }
}

/**
 * @param {number} rev
 * @returns {Promise<void>}
 */
export async function setCachedRev(rev) {
    const store = getCharacterCacheStore();
    try {
        await store.setItem(REV_KEY, rev);
    } catch (error) {
        console.error('Failed to persist cached character revision:', error);
    }
}

/**
 * Reads every cached character, keyed by avatar. This IS the client's current view of the whole library once
 * it's caught up with the change feed - unlike the old manifest-diff scheme, nothing here needs a fresh
 * ground-truth listing from the server to know the full current id set: every real mutation since this cache's
 * last synced rev arrives as an explicit `changes` entry (upsert or delete), so applying those on top of
 * whatever's already cached is sufficient (see fetchCharactersDelta() in script.js).
 * @returns {Promise<Map<string, object>>} avatar -> already-processed character object.
 */
export async function getAllCachedCharacters() {
    const store = getCharacterCacheStore();
    const result = new Map();
    try {
        await store.iterate((record, key) => {
            if (key === REV_KEY) return;
            if (record && record.character) {
                result.set(key, record.character);
            }
        });
    } catch (error) {
        console.error('Failed to read cached character data:', error);
    }
    return result;
}

/**
 * Persists freshly-fetched characters into the cache, keyed by avatar. Callers should pass already fully
 * processed character objects (DOMPurify-sanitized name, defaulted chat, etc. - i.e. exactly what would've been
 * assigned into the `characters` array before this cache existed), since getAllCachedCharacters() returns cache
 * hits as-is with no further processing applied on the next read.
 *
 * Deliberately does NOT also store a per-record revision/hash alongside the character data. The state-digest
 * drift check (script.js's verifyCharacterCacheDigest()) needs to prove this cache's content still matches the
 * server's - and a value stored here at write time would just be one more thing that could silently go stale or
 * wrong, exactly like the data it's meant to verify. Instead that check hashes whatever's actually sitting in
 * `character` at verification time, fresh, every time - see public/scripts/hash-utils.js's header for the full
 * reasoning on why content-derived hashing is the fix, not a second stored value to trust.
 * @param {{avatar: string, character: object}[]} entries
 */
export async function saveCachedCharacters(entries) {
    const store = getCharacterCacheStore();
    await Promise.all(entries.map(({ avatar, character }) =>
        store.setItem(avatar, { character }).catch(error =>
            console.error(`Failed to cache character data for ${avatar}:`, error))));
}

/**
 * Removes cached entries directly by avatar id - used for `op: 'delete'` entries from `/api/characters/changes`,
 * which name exactly what was deleted rather than requiring the client to infer deletions from absence in a
 * full manifest (the old scheme's `pruneCharacterCache()`, which this replaces).
 * @param {string[]} avatars
 */
export async function removeCachedCharacters(avatars) {
    const store = getCharacterCacheStore();
    await Promise.all(avatars.map(avatar =>
        store.removeItem(avatar).catch(error =>
            console.error(`Failed to remove cached character data for ${avatar}:`, error))));
}

/**
 * Drops the entire character cache (including the revision cursor) for the current user. Used as a fallback
 * when the change-feed/batch delta path fails or looks inconsistent (including a `truncated: true` response -
 * see fetchCharactersDelta()), so the next successful sync starts from a clean `sinceRev: 0` slate instead of
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
