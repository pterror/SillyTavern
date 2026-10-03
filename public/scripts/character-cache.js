import { localforage } from '../lib.js';
import { getCurrentUserHandle } from './user.js';
import { groupDigestFavHash, groupDigestTagIdsHash, groupDigestContentHash, normalizeTagIds } from './hash-utils.js';

// Client-side residency cache for character data, keyed off the server's per-item change feed
// (`getChangesSince()`) rather than a per-character mtime. One IndexedDB database per user handle.

// Bumped when the form records are stored in changes (GROUP_HASH_VERSION likewise); records with a different/missing
// version read as cache misses.
const HASH_VERSION = 5;

// Top-level fields Spec V2 cards mirror under `data.*` for V1 back-compat; saveCachedCharacters()
// strips a byte-identical top-level copy and records it in `dedup`, restored by readers on the way out.
const DUPLICATE_FIELDS = ['description', 'first_mes', 'mes_example', 'scenario', 'tags', 'personality'];

// Mutates and returns `character` in place - safe since callers only pass a freshly IDB-deserialized
// object with no other live references.
function rehydrateDuplicateFields(character, dedup) {
    if (dedup && dedup.length && character?.data) {
        for (const field of dedup) {
            character[field] = character.data[field];
        }
    }
    return character;
}

// Bumped only if the dedup transform itself changes, forcing every record to be reconsidered even
// if it already carries a stamp from an older transform.
const DEDUP_VERSION = 1;

/** Guards against overlapping migration passes when getAllCachedCharacters() is called multiple times in one boot/sync cycle. */
let dedupMigrationStarted = false;

/** Never mutates `character`. */
function computeDedupSplit(character) {
    let toStore = character;
    let dedup;
    for (const field of DUPLICATE_FIELDS) {
        if (character.data && field in character &&
            JSON.stringify(character[field]) === JSON.stringify(character.data[field])) {
            if (toStore === character) toStore = { ...character };
            delete toStore[field];
            (dedup ??= []).push(field);
        }
    }
    return { toStore, dedup };
}

// Never awaited by its caller - background reclamation. Interruption-safe with no progress cursor:
// a record is only stamped `dedupV` after its rewrite commits.
async function migrateDedupCompression(store, unmigrated) {
    console.log(`[character-cache] Compressing ${unmigrated.length} cached record(s) that predate v1/v2 field dedup...`);
    const MIGRATE_BATCH = 500;
    for (let i = 0; i < unmigrated.length; i += MIGRATE_BATCH) {
        const batch = unmigrated.slice(i, i + MIGRATE_BATCH);
        await Promise.all(batch.map(([key, record]) => {
            const { toStore, dedup } = computeDedupSplit(record.character);
            return store.setItem(key, { ...record, character: toStore, dedup, dedupV: DEDUP_VERSION }).catch(error =>
                console.error(`Failed to compress cached character data for ${key}:`, error));
        }));
        // Yield between batches so a multi-hundred-thousand-record pass doesn't freeze the browser.
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    console.log(`[character-cache] Compression migration complete (${unmigrated.length} record(s)).`);
}

/** @type {Map<string, LocalForage>} */
const storesByHandle = new Map();

// Never collides with a real avatar filename, which always ends in `.png`.
const CURSOR_KEY = '__cursor__';

// Pre-rename name of CURSOR_KEY, still present in caches written before the rename.
const LEGACY_REV_KEY = '__rev__';

// No longer written or read; removed from caches that still carry it.
const STALE_DIGEST_KEY = '__last_verified_digest__';
let staleDigestKeyRemoved = false;

/** The user the browser-storage caches are kept for. */
export function getCacheUserHandle() {
    return getCurrentUserHandle();
}

function getCharacterCacheStore() {
    const handle = getCurrentUserHandle();
    let store = storesByHandle.get(handle);
    if (!store) {
        store = localforage.createInstance({ name: `SillyTavern_CharacterCache_${handle}` });
        storesByHandle.set(handle, store);
    }
    return store;
}

/** `0` (never synced) is a legitimate value - `getChangesSince()` treats `sinceRev: 0` as "send everything". */
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
        if (!staleDigestKeyRemoved) {
            staleDigestKeyRemoved = true;
            await store.removeItem(STALE_DIGEST_KEY).catch(error => console.error('Failed to remove stale digest record:', error));
        }
        return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : 0;
    } catch (error) {
        console.error('Failed to read cached character revision:', error);
        return 0;
    }
}

export async function setCachedCursor(seq) {
    const store = getCharacterCacheStore();
    try {
        await store.setItem(CURSOR_KEY, seq);
    } catch (error) {
        console.error('Failed to persist cached character revision:', error);
    }
}

const WRITE_FAILURES_KEY = '__write_failures__';

/** Avatar IDs whose IDB write failed on the last sync; fetchCharactersDelta retries these on next boot. */
export async function getWriteFailures() {
    const store = getCharacterCacheStore();
    try {
        const failures = await store.getItem(WRITE_FAILURES_KEY);
        return Array.isArray(failures) ? failures : [];
    } catch {
        return [];
    }
}

/** Empty array clears the failure list. */
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

/** Reads every cached character, keyed by avatar - the client's full view once caught up with the change feed. */
export async function getAllCachedCharacters() {
    const store = getCharacterCacheStore();
    const result = new Map();
    /** @type {[string, object][]} */
    const unmigrated = [];
    try {
        await store.iterate((record, key) => {
            if (key === CURSOR_KEY || key === LEGACY_REV_KEY || key === WRITE_FAILURES_KEY) return;
            if (record && record.character) {
                result.set(key, rehydrateDuplicateFields(record.character, record.dedup));
                if (record.dedupV !== DEDUP_VERSION) {
                    unmigrated.push([key, record]);
                }
            }
        });
    } catch (error) {
        console.error('Failed to read cached character data:', error);
    }
    if (unmigrated.length > 0 && !dedupMigrationStarted) {
        dedupMigrationStarted = true;
        migrateDedupCompression(store, unmigrated);
    }
    return result;
}

/** Reads the cached characters for `ids`, keyed by avatar; an id with no cached record is absent from the result. */
export async function readCachedCharactersByIds(ids) {
    const store = getCharacterCacheStore();
    const result = new Map();
    await Promise.all(ids.map(async (id) => {
        try {
            const record = await store.getItem(id);
            if (record && record.character) {
                result.set(id, rehydrateDuplicateFields(record.character, record.dedup));
            }
        } catch (error) {
            console.error(`Failed to read cached character data for ${id}:`, error);
        }
    }));
    return result;
}

// A record whose `hashes.version` is the server's version for the character can be used as-is with zero refetch.
export async function getCachedEntriesByIds(ids) {
    const store = getCharacterCacheStore();
    const result = new Map();
    await Promise.all(ids.map(async (id) => {
        try {
            const record = await store.getItem(id);
            if (record?.character && record?.hashes?.v === HASH_VERSION) {
                rehydrateDuplicateFields(record.character, record.dedup);
                result.set(id, record);
            }
        } catch (error) {
            console.error(`Failed to read cached entry for ${id}:`, error);
        }
    }));
    return result;
}

/**
 * Callers must pass already fully processed character objects - reads return cache hits as-is, unprocessed.
 * @param {{avatar: string, character: object, version?: number}[]} entries `version`: the server's version of the
 *   character the record was read at, when the caller knows it; a record without one never counts as current.
 * @returns {Promise<string[]>} avatars whose write failed
 */
export async function saveCachedCharacters(entries) {
    const store = getCharacterCacheStore();
    const failed = [];
    // Batched so a large backfill doesn't fire hundreds of thousands of concurrent setItem calls.
    const SAVE_BATCH = 500;
    for (let i = 0; i < entries.length; i += SAVE_BATCH) {
        const batch = entries.slice(i, i + SAVE_BATCH);
        await Promise.all(batch.map(({ avatar, character: given, version }) => {
            const character = { ...given, tag_ids: normalizeTagIds(given.tag_ids) };
            const hashes = { version: typeof version === 'number' ? version : null, v: HASH_VERSION };
            // Never mutates the caller's (possibly still-live) object.
            const { toStore, dedup } = computeDedupSplit(character);
            return store.setItem(avatar, { character: toStore, hashes, dedup, dedupV: DEDUP_VERSION }).catch(error => {
                console.error(`Failed to cache character data for ${avatar}:`, error);
                failed.push(avatar);
            });
        }));
    }
    return failed;
}

export async function removeCachedCharacters(avatars) {
    const store = getCharacterCacheStore();
    await Promise.all(avatars.map(avatar =>
        store.removeItem(avatar).catch(error =>
            console.error(`Failed to remove cached character data for ${avatar}:`, error))));
}

/** Fallback for when the change-feed/batch delta path fails or looks inconsistent - forces a clean `sinceRev: 0` resync. */
export async function clearCharacterCache() {
    const store = getCharacterCacheStore();
    try {
        await store.clear();
    } catch (error) {
        console.error('Failed to clear character cache:', error);
    }
}

/** Separate IndexedDB instance, not a namespace in the character store - groups are always resident, never lazily faulted like characters. */
const GROUP_HASH_VERSION = 3;

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

/** Group-side counterpart to getCachedEntriesByIds() above. */
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

/** Group-side counterpart to saveCachedCharacters() above. */
export async function saveCachedGroups(entries) {
    const store = getGroupCacheStore();
    const failed = [];
    const SAVE_BATCH = 500;
    for (let i = 0; i < entries.length; i += SAVE_BATCH) {
        const batch = entries.slice(i, i + SAVE_BATCH);
        await Promise.all(batch.map(({ id, group: given }) => {
            const group = { ...given, tag_ids: normalizeTagIds(given.tag_ids) };
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
