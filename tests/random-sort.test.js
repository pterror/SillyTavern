import { describe, test, expect, jest } from '@jest/globals';
import {
    RANDOM_SORT_SEED_KEY,
    mintRandomSortSeed,
    getRandomSortSeed,
    rerollRandomSortSeed,
    compareByRandomSeed,
} from '../public/scripts/random-sort.js';

/** Minimal in-memory stand-in for accountStorage's `{ getItem, setItem }` surface. */
function makeStorage(initial = {}) {
    const state = { ...initial };
    return {
        state,
        getItem: jest.fn(key => (Object.hasOwn(state, key) ? String(state[key]) : null)),
        setItem: jest.fn((key, value) => { state[key] = String(value); }),
    };
}

describe('mintRandomSortSeed', () => {
    test('produces a 32-bit-range integer', () => {
        for (let i = 0; i < 50; i++) {
            const seed = mintRandomSortSeed();
            expect(Number.isInteger(seed)).toBe(true);
            expect(seed).toBeGreaterThanOrEqual(0);
            expect(seed).toBeLessThan(0x100000000);
        }
    });
});

describe('getRandomSortSeed', () => {
    test('mints and persists a seed lazily when none is stored yet - no migration needed for existing installs', () => {
        const storage = makeStorage();
        const seed = getRandomSortSeed(storage);
        expect(Number.isFinite(seed)).toBe(true);
        expect(storage.setItem).toHaveBeenCalledWith(RANDOM_SORT_SEED_KEY, String(seed));
    });

    test('returns the already-stored seed without minting a new one', () => {
        const storage = makeStorage({ [RANDOM_SORT_SEED_KEY]: '12345' });
        const seed = getRandomSortSeed(storage);
        expect(seed).toBe(12345);
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    test('re-mints if the stored value is garbage', () => {
        const storage = makeStorage({ [RANDOM_SORT_SEED_KEY]: 'not-a-number' });
        const seed = getRandomSortSeed(storage);
        expect(Number.isFinite(seed)).toBe(true);
        expect(storage.setItem).toHaveBeenCalled();
    });
});

describe('rerollRandomSortSeed', () => {
    test('persists a new seed, overwriting whatever was stored', () => {
        const storage = makeStorage({ [RANDOM_SORT_SEED_KEY]: '1' });
        const seed = rerollRandomSortSeed(storage);
        expect(storage.state[RANDOM_SORT_SEED_KEY]).toBe(String(seed));
    });

    test('reroll changes the seed (with overwhelming probability), so it changes downstream ordering', () => {
        const storage = makeStorage({ [RANDOM_SORT_SEED_KEY]: '1' });
        const before = getRandomSortSeed(storage);
        const after = rerollRandomSortSeed(storage);
        expect(after).not.toBe(before);
    });
});

describe('compareByRandomSeed', () => {
    const keys = ['character.a', 'character.b', 'character.c', 'character.d', 'group.1', 'group.2'];

    test('is a stable total order: sorting twice with the same seed gives the same order', () => {
        const seed = 999;
        const order1 = [...keys].sort((a, b) => compareByRandomSeed(a, b, seed));
        const order2 = [...keys].sort((a, b) => compareByRandomSeed(a, b, seed));
        expect(order1).toEqual(order2);
    });

    test('a different seed produces a different order (with overwhelming probability over this many keys)', () => {
        const orderA = [...keys].sort((a, b) => compareByRandomSeed(a, b, 1));
        const orderB = [...keys].sort((a, b) => compareByRandomSeed(a, b, 2));
        expect(orderA).not.toEqual(orderB);
    });

    test('narrowing the candidate set never reorders whichever keys survive', () => {
        const seed = 424242;
        const fullOrder = [...keys].sort((a, b) => compareByRandomSeed(a, b, seed));
        const narrowed = keys.filter(k => k !== 'character.b' && k !== 'group.1');
        const narrowedOrder = [...narrowed].sort((a, b) => compareByRandomSeed(a, b, seed));
        // The narrowed order should just be the full order with the removed keys dropped out.
        expect(narrowedOrder).toEqual(fullOrder.filter(k => narrowed.includes(k)));
    });
});
