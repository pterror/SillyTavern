/**
 * Comparator-based random sort: order is a hash of (key, seed) rather than a stored permutation, so it stays
 * a stable total order across renders instead of reshuffling every time.
 */

import { getStringHash } from './hash-utils.js';

/** @type {string} */
export const RANDOM_SORT_SEED_KEY = 'CharacterListRandomSortSeed';

/**
 * @typedef {object} SeedStorage
 * @property {(key: string) => string|null} getItem
 * @property {(key: string, value: string) => void} setItem
 */

/** Not cryptographic - only needs to decorrelate order between rerolls, not resist prediction. */
export function mintRandomSortSeed() {
    return Math.floor(Math.random() * 0x100000000);
}

/** Mints and persists a seed on first use, so existing installs need no migration. */
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

/** Changing the seed changes the ordering, so callers should reset to page 1 when calling this. */
export function rerollRandomSortSeed(storage) {
    const seed = mintRandomSortSeed();
    storage.setItem(RANDOM_SORT_SEED_KEY, String(seed));
    return seed;
}

/** A total order over every possible key, so it's well-defined even for rows never seen before. */
export function compareByRandomSeed(aKey, bKey, seed) {
    return getStringHash(aKey, seed) - getStringHash(bKey, seed);
}
