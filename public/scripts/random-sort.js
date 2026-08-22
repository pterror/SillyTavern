/**
 * Seeded random-sort ordering for the character/group list (design doc: docs/design/
 * character-data-residency-redesign.md, §5.3 / Phase 5b). Replaces `shuffle()` with a comparator over
 * `getStringHash(entityKey, seed)`, so random order is a stable total order rather than a fresh permutation
 * on every render.
 *
 * Dependency-free by design (no jQuery/DOM, no other app modules besides hash-utils.js) so it stays
 * importable in a plain Node test environment - see tests/random-sort.test.js. The seed itself is read from
 * and written to whatever storage-like object (`{ getItem, setItem }`) the caller passes in - power-user.js
 * passes the real `accountStorage` singleton; tests pass a plain in-memory stand-in.
 */

import { getStringHash } from './hash-utils.js';

/** @type {string} accountStorage key the seed is persisted under (per-user, survives reloads). */
export const RANDOM_SORT_SEED_KEY = 'CharacterListRandomSortSeed';

/**
 * @typedef {object} SeedStorage
 * @property {(key: string) => string|null} getItem
 * @property {(key: string, value: string) => void} setItem
 */

/**
 * Mints a fresh random seed. Not cryptographic - this only needs to decorrelate hash order between rerolls,
 * not resist prediction.
 * @returns {number} A new seed in [0, 2^32).
 */
export function mintRandomSortSeed() {
    return Math.floor(Math.random() * 0x100000000);
}

/**
 * Returns the current random-sort seed, minting and persisting one on first use so existing installs need no
 * migration.
 * @param {SeedStorage} storage Storage to read/write the seed from.
 * @returns {number} The seed.
 */
export function getRandomSortSeed(storage) {
    const stored = storage.getItem(RANDOM_SORT_SEED_KEY);
    if (stored !== null && stored !== undefined && stored !== '') {
        const parsed = Number(stored);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return rerollRandomSortSeed(storage);
}

/**
 * Mints a new seed and persists it, discarding whatever was stored before. This is the reroll button's
 * entire job: because the seed is part of the ordering (and, once server pagination lands, part of the
 * pagination cursor's identity), the caller is expected to reset to page 1 alongside calling this.
 * @param {SeedStorage} storage Storage to write the new seed to.
 * @returns {number} The new seed.
 */
export function rerollRandomSortSeed(storage) {
    const seed = mintRandomSortSeed();
    storage.setItem(RANDOM_SORT_SEED_KEY, String(seed));
    return seed;
}

/**
 * Comparator for random sort: orders two entity keys by their seeded hash. A total order over every possible
 * key, so it is well-defined for rows the client has never seen, and narrowing the candidate set (e.g. by
 * search) never reorders whichever keys survive - they were already in this order.
 * @param {string} aKey Stable key for entity a (e.g. `${type}.${id}`).
 * @param {string} bKey Stable key for entity b.
 * @param {number} seed The active random-sort seed.
 * @returns {number} Standard comparator result.
 */
export function compareByRandomSeed(aKey, bKey, seed) {
    return getStringHash(aKey, seed) - getStringHash(bKey, seed);
}
