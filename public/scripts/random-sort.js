import { getStringHash } from './hash-utils.js';

/** @type {string} */
export const RANDOM_SORT_SEED_KEY = 'CharacterListRandomSortSeed';

/**
 * @typedef {object} SeedStorage
 * @property {(key: string) => string|null} getItem
 * @property {(key: string, value: string) => void} setItem
 */

export function mintRandomSortSeed() {
    return Math.floor(Math.random() * 0x100000000);
}

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

export function rerollRandomSortSeed(storage) {
    const seed = mintRandomSortSeed();
    storage.setItem(RANDOM_SORT_SEED_KEY, String(seed));
    return seed;
}

export function compareByRandomSeed(aKey, bKey, seed) {
    return getStringHash(aKey, seed) - getStringHash(bKey, seed);
}
