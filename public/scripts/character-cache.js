import { localforage } from '../lib.js';
import { getCurrentUserHandle } from './user.js';
import { characterDigestFavHash, characterDigestFieldsHash, characterDigestTagIdsHash } from './hash-utils.js';

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

// Reserved key for the last-verified root digest (see verifyCharacterCacheDigest's fast-path skip).
const LAST_VERIFIED_DIGEST_KEY = '__last_verified_digest__';

/**
 * The 128-bit root digest that was current when the last successful digest verification completed.
 * Content-derived (XOR-fold of all per-record per-field hashes), not a counter - so it can't
 * silently be wrong the way a rev counter can. If the server's current root matches this, nothing
 * has changed since the last full verification, and the expensive O(library) client-side
 * recomputation can be skipped entirely.
 * @returns {Promise<{a: number, b: number, c: number, d: number} | null>}
 */
export async function getLastVerifiedDigest() {
    const store = getCharacterCacheStore();
    try {
        const digest = await store.getItem(LAST_VERIFIED_DIGEST_KEY);
        if (digest && typeof digest.a === 'number' && typeof digest.b === 'number' &&
            typeof digest.c === 'number' && typeof digest.d === 'number') {
            return digest;
        }
        return null;
    } catch (error) {
        console.error('Failed to read last verified digest:', error);
        return null;
    }
}

/**
 * @param {{a: number, b: number, c: number, d: number}} digest
 * @returns {Promise<void>}
 */
export async function setLastVerifiedDigest(digest) {
    const store = getCharacterCacheStore();
    try {
        await store.setItem(LAST_VERIFIED_DIGEST_KEY, digest);
    } catch (error) {
        console.error('Failed to persist last verified digest:', error);
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
 * Reads per-field hashes for every cached character, keyed by avatar. These were computed and stored
 * atomically with the character data in saveCachedCharacters(), so they're guaranteed to match the
 * record they describe. Verification reads these instead of the full character data (~24 bytes per
 * record instead of ~1KB), avoiding the expensive IDB deserialize + structured-clone + rehash that
 * previously dominated the digest check.
 *
 * Falls back gracefully for records cached before hashes were stored: a missing `hashes` field
 * is simply omitted from the result, and the caller recomputes those records' hashes on demand.
 * @returns {Promise<Map<string, {fav: number, tagIds: number, content: number}>>} avatar -> hashes
 */
export async function getAllCachedHashes() {
    const store = getCharacterCacheStore();
    const result = new Map();
    try {
        await store.iterate((record, key) => {
            if (key === REV_KEY || key === LAST_VERIFIED_DIGEST_KEY) return;
            if (record?.hashes) {
                result.set(key, record.hashes);
            }
        });
    } catch (error) {
        console.error('Failed to read cached character hashes:', error);
    }
    return result;
}

/**
 * Persists freshly-fetched characters into the cache, keyed by avatar. Callers should pass already fully
 * processed character objects (DOMPurify-sanitized name, defaulted chat, etc. - i.e. exactly what would've been
 * assigned into the `characters` array before this cache existed), since getAllCachedCharacters() returns cache
 * hits as-is with no further processing applied on the next read.
 *
 * Also stores per-field hashes (fav, tagIds, content) alongside the character data in the same IDB write, so
 * they can never drift from the record they describe. The state-digest drift check (script.js's
 * verifyCharacterCacheDigest()) reads these instead of recomputing from the full character data - see
 * getAllCachedHashes() and public/scripts/hash-utils.js's header for the full reasoning on the hashing scheme.
 * @param {{avatar: string, character: object}[]} entries
 */
export async function saveCachedCharacters(entries) {
    const store = getCharacterCacheStore();
    // Batched to avoid overwhelming IndexedDB with hundreds of thousands of concurrent writes
    // (a one-time tag_ids backfill across 314k records would otherwise fire 314k concurrent
    // setItem calls via Promise.all, making the browser unresponsive for seconds).
    const SAVE_BATCH = 500;
    for (let i = 0; i < entries.length; i += SAVE_BATCH) {
        const batch = entries.slice(i, i + SAVE_BATCH);
        await Promise.all(batch.map(({ avatar, character }) => {
            // Per-field hashes stored atomically with the character data in the same IDB write,
            // so they can never drift from the record they describe. Verification reads these
            // instead of recomputing from scratch (O(1) per record instead of O(fields)).
            const hashes = {
                fav: characterDigestFavHash(character) % 4294967296,
                tagIds: characterDigestTagIdsHash(character),
                content: characterDigestFieldsHash(character) % 4294967296,
            };
            return store.setItem(avatar, { character, hashes }).catch(error =>
                console.error(`Failed to cache character data for ${avatar}:`, error));
        }));
    }
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
