import { localforage } from '../lib.js';
import { getCurrentUserHandle } from './user.js';
import { characterDigestFavHash, characterDigestFieldsHash, characterDigestTagIdsHash, groupDigestFavHash, groupDigestTagIdsHash, groupDigestContentHash } from './hash-utils.js';

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

/** Bumped when the hash function's output changes (e.g. removing DOMPurify from character.name).
 * Records with a different or missing version get their hashes recomputed on first read. */
const HASH_VERSION = 2;

/** @type {Map<string, LocalForage>} */
const storesByHandle = new Map();

// Reserved key for the change-feed revision cursor (see getCachedCursor()/setCachedCursor()) - never collides
// with a real avatar filename, which always ends in `.png`.
const CURSOR_KEY = '__cursor__';

// Pre-rename name of CURSOR_KEY, still present in caches written before the rename. Read once and migrated
// forward by getCachedCursor(); nothing ever writes it again.
const LEGACY_REV_KEY = '__rev__';

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
export async function getCachedCursor() {
    const store = getCharacterCacheStore();
    try {
        let cursor = await store.getItem(CURSOR_KEY);
        if (cursor === null || cursor === undefined) {
            // One-time migration from the pre-rename key.
            const legacy = await store.getItem(LEGACY_REV_KEY);
            if (legacy !== null && legacy !== undefined) {
                await store.setItem(CURSOR_KEY, legacy);
                await store.removeItem(LEGACY_REV_KEY);
                cursor = legacy;
            }
        }
        return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : 0;
    } catch (error) {
        console.error('Failed to read cached character revision:', error);
        return 0;
    }
}

/**
 * @param {number} seq
 * @returns {Promise<void>}
 */
export async function setCachedCursor(seq) {
    const store = getCharacterCacheStore();
    try {
        await store.setItem(CURSOR_KEY, seq);
    } catch (error) {
        console.error('Failed to persist cached character revision:', error);
    }
}

// Reserved key for the last-verified root digest (see verifyCharacterCacheDigest's fast-path skip).
const LAST_VERIFIED_DIGEST_KEY = '__last_verified_digest__';

// Reserved key for tracking IDB write failures (see fetchCharactersDelta's retry-on-failure path).
const WRITE_FAILURES_KEY = '__write_failures__';

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
 * Avatar IDs whose IDB write failed on the last sync. fetchCharactersDelta re-fetches these on the
 * next boot so the failure is retried exactly once, driven by the actual failure event rather than
 * a periodic verification sweep.
 * @returns {Promise<string[]>}
 */
export async function getWriteFailures() {
    const store = getCharacterCacheStore();
    try {
        const failures = await store.getItem(WRITE_FAILURES_KEY);
        return Array.isArray(failures) ? failures : [];
    } catch {
        return [];
    }
}

/**
 * @param {string[]} ids Empty array clears the failure list.
 * @returns {Promise<void>}
 */
export async function setWriteFailures(ids) {
    const store = getCharacterCacheStore();
    try {
        if (ids.length > 0) {
            await store.setItem(WRITE_FAILURES_KEY, ids);
        } else {
            await store.removeItem(WRITE_FAILURES_KEY);
        }
    } catch (error) {
        console.error('Failed to persist write failures:', error);
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
            if (key === CURSOR_KEY || key === LEGACY_REV_KEY || key === WRITE_FAILURES_KEY) return;
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
/**
 * Reads per-field hashes for every cached character, keyed by avatar. These were computed and stored
 * atomically with the character data in saveCachedCharacters(), so they're guaranteed to match the
 * record they describe. Verification reads these instead of the full character data (~24 bytes per
 * record instead of ~1KB), avoiding the expensive IDB deserialize + structured-clone + rehash that
 * previously dominated the digest check.
 *
 * Migration: records cached before hash storage was added lack a `hashes` field. These are computed
 * from the character data on first encounter and persisted back to IDB (batched with yields), so
 * subsequent calls read stored hashes for all records. This is a one-time cost proportional to the
 * number of unhashed records, not the library size on every call.
 * @returns {Promise<Map<string, {fav: number, tagIds: number, content: number}>>} avatar -> hashes
 */
export async function getAllCachedHashes() {
    const store = getCharacterCacheStore();
    const result = new Map();
    /** @type {[string, object][]} [key, record] pairs needing hash computation */
    const unhashed = [];
    try {
        await store.iterate((record, key) => {
            if (key === CURSOR_KEY || key === LEGACY_REV_KEY || key === LAST_VERIFIED_DIGEST_KEY || key === WRITE_FAILURES_KEY) return;
            if (record?.hashes?.v === HASH_VERSION) {
                result.set(key, record.hashes);
            } else if (record?.character) {
                // Collect for migration - hash computation + persist happens in batches below.
                unhashed.push([key, record]);
            }
        });
    } catch (error) {
        console.error('Failed to read cached character hashes:', error);
    }

    // Migration: compute and persist hashes for records that predate hash storage.
    // Batched with yields so the main thread stays responsive during the one-time migration.
    if (unhashed.length > 0) {
        console.log(`[character-cache] Computing hashes for ${unhashed.length} cached record(s) that predate hash storage...`);
        const MIGRATE_BATCH = 500;
        for (let i = 0; i < unhashed.length; i += MIGRATE_BATCH) {
            const batch = unhashed.slice(i, i + MIGRATE_BATCH);
            const toStore = [];
            for (const [key, record] of batch) {
                const character = record.character;
                // Restore raw name from data.name if it was mangled by the now-removed
                // DOMPurify sanitization (data.name was never sanitized).
                if (character?.data?.name !== undefined) {
                    character.name = character.data.name;
                }
                const hashes = {
                    fav: characterDigestFavHash(character) % 4294967296,
                    tagIds: characterDigestTagIdsHash(character),
                    content: characterDigestFieldsHash(character) % 4294967296,
                    v: HASH_VERSION,
                };
                result.set(key, hashes);
                toStore.push({ key, value: { character, hashes } });
            }
            // Persist the batch back to IDB so next call reads stored hashes directly.
            await Promise.all(toStore.map(({ key, value }) =>
                store.setItem(key, value).catch(error =>
                    console.error(`Failed to persist migrated hashes for ${key}:`, error))));
        }
        console.log(`[character-cache] Hash migration complete (${unhashed.length} record(s)).`);
    }

    return result;
}

/**
 * Reads per-field hashes for a specific set of cached characters, keyed by avatar. Used by the
 * incremental digest path in fetchCharactersDelta() to read old hashes before mutations.
 * @param {string[]} ids Avatar filenames to look up.
 * @returns {Promise<Map<string, {fav: number, tagIds: number, content: number}>>} avatar -> hashes (only for ids that exist and have valid hashes)
 */
export async function getCachedHashesByIds(ids) {
    const store = getCharacterCacheStore();
    const result = new Map();
    await Promise.all(ids.map(async (id) => {
        try {
            const record = await store.getItem(id);
            if (record?.hashes?.v === HASH_VERSION) {
                result.set(id, record.hashes);
            }
        } catch (error) {
            console.error(`Failed to read cached hash for ${id}:`, error);
        }
    }));
    return result;
}

/**
 * Reads full cached entries (character + hashes) for a specific set of ids in one pass - the per-id-cache half
 * of `/query`'s hash-only mode (2026-09 /query bandwidth pass, `CharacterRepository.query()` in
 * character-repository.js): given the `{id, favHash, tagIdsHash, contentHash}` rows the server's hash-mode
 * response carries, a caller checks each id's hashes against what's stored here - a match means the cached
 * `character` object can be used as-is with zero refetch; a miss (or absent entry) means the id needs to go
 * through `/api/characters/batch` for its actual field values.
 *
 * Deliberately a single combined read (character + hashes together) rather than `getCachedHashesByIds()` followed
 * by a second per-id character read: they're stored under the same key in the same IDB write already
 * (`saveCachedCharacters()` below), so reading them apart would just be two IDB round trips for data that's
 * always fetched and used together here.
 * @param {string[]} ids
 * @returns {Promise<Map<string, {character: object, hashes: {fav: number, tagIds: number, content: number}}>>}
 * keyed by id; ids with no cached entry, or whose stored hash predates `HASH_VERSION`, are simply absent.
 */
export async function getCachedEntriesByIds(ids) {
    const store = getCharacterCacheStore();
    const result = new Map();
    await Promise.all(ids.map(async (id) => {
        try {
            const record = await store.getItem(id);
            if (record?.character && record?.hashes?.v === HASH_VERSION) {
                result.set(id, record);
            }
        } catch (error) {
            console.error(`Failed to read cached entry for ${id}:`, error);
        }
    }));
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
 * @returns {Promise<string[]>} Avatar IDs that failed to write (empty if all succeeded).
 */
export async function saveCachedCharacters(entries) {
    const store = getCharacterCacheStore();
    const failed = [];
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
                v: HASH_VERSION,
            };
            return store.setItem(avatar, { character, hashes }).catch(error => {
                console.error(`Failed to cache character data for ${avatar}:`, error);
                failed.push(avatar);
            });
        }));
    }
    return failed;
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

/**
 * Group-side persisted cache (2026-09, extending /query's hash-mode client caching to `includeGroups: true`
 * requests). A separate IndexedDB instance, not a second key namespace inside the character store above -
 * groups were never part of that store's boot-time manifest/batch/changes sync (they're "always resident" per
 * the design doc, never lazily faulted in the way characters are), so this is a genuinely new cache, not an
 * extension of an existing one. Same per-id `{group, hashes: {fav, tagIds, content, v}}` shape as the character
 * store, same `HASH_VERSION` migrate-on-read convention, for the same reasons (see that constant's own comment
 * above) - kept as its own constant (`GROUP_HASH_VERSION`) rather than shared, since a future change to either
 * digest scheme shouldn't force a cache-wide invalidation of the other.
 */
const GROUP_HASH_VERSION = 1;

/** @type {Map<string, LocalForage>} */
const groupStoresByHandle = new Map();

/** @returns {LocalForage} The group cache store for the currently logged-in user. */
function getGroupCacheStore() {
    const handle = getCurrentUserHandle();
    let store = groupStoresByHandle.get(handle);
    if (!store) {
        store = localforage.createInstance({ name: `SillyTavern_GroupCache_${handle}` });
        groupStoresByHandle.set(handle, store);
    }
    return store;
}

/**
 * Reads full cached entries (group + hashes) for a specific set of group ids - the group-side counterpart to
 * getCachedEntriesByIds() above. See that function's own doc comment for the full reasoning (identical here,
 * just against the group store instead of the character one).
 * @param {string[]} ids
 * @returns {Promise<Map<string, {group: object, hashes: {fav: number, tagIds: number, content: number}}>>}
 */
export async function getCachedGroupEntriesByIds(ids) {
    const store = getGroupCacheStore();
    const result = new Map();
    await Promise.all(ids.map(async (id) => {
        try {
            const record = await store.getItem(id);
            if (record?.group && record?.hashes?.v === GROUP_HASH_VERSION) {
                result.set(id, record);
            }
        } catch (error) {
            console.error(`Failed to read cached group entry for ${id}:`, error);
        }
    }));
    return result;
}

/**
 * Persists freshly-fetched groups into the cache, keyed by id - the group-side counterpart to
 * saveCachedCharacters() above. Computes and stores the same three-way digest split
 * (groupDigestFavHash/TagIdsHash/ContentHash, hash-utils.js) the server's own write-path hooks compute
 * (upsertGroupRowSync()/assignEntityTag()'s group branch, character-metadata-db.js) - same shared-module
 * guarantee that keeps the two sides comparable, same reasoning characters already rely on.
 * @param {{id: string, group: object}[]} entries
 * @returns {Promise<string[]>} ids that failed to write.
 */
export async function saveCachedGroups(entries) {
    const store = getGroupCacheStore();
    const failed = [];
    const SAVE_BATCH = 500;
    for (let i = 0; i < entries.length; i += SAVE_BATCH) {
        const batch = entries.slice(i, i + SAVE_BATCH);
        await Promise.all(batch.map(({ id, group }) => {
            const hashes = {
                fav: groupDigestFavHash(group),
                tagIds: groupDigestTagIdsHash(group),
                content: groupDigestContentHash(group),
                v: GROUP_HASH_VERSION,
            };
            return store.setItem(id, { group, hashes }).catch(error => {
                console.error(`Failed to cache group data for ${id}:`, error);
                failed.push(id);
            });
        }));
    }
    return failed;
}
