import { describe, test, expect } from '@jest/globals';
import { pagerSelection, selectedGreetingIndex } from '../public/scripts/greeting-pager-selection.js';

describe('selectedGreetingIndex', () => {
    test('a new list of the same card keeps the selected greeting', () => {
        expect(selectedGreetingIndex({ owner: 'a.png', index: 2, id: 30 }, 'a.png', [10, 20, 30], 3)).toBe(2);
    });

    test('the selected greeting is followed to where it moved, by its id', () => {
        expect(selectedGreetingIndex({ owner: 'a.png', index: 2, id: 30 }, 'a.png', [30, 10, 20], 3)).toBe(0);
    });

    test('a selected greeting that is gone keeps the position, clamped to the list', () => {
        expect(selectedGreetingIndex({ owner: 'a.png', index: 2, id: 30 }, 'a.png', [10, 20, 40], 3)).toBe(2);
        expect(selectedGreetingIndex({ owner: 'a.png', index: 2, id: 30 }, 'a.png', [10, 20], 2)).toBe(1);
    });

    test('an unsaved greeting keeps its position, also beside an empty saved one', () => {
        expect(selectedGreetingIndex({ owner: 'a.png', index: 3, id: undefined }, 'a.png', [10, 20, 30, undefined], 4)).toBe(3);
        expect(selectedGreetingIndex({ owner: 'a.png', index: 0, id: 2 }, 'a.png', [0, 1, 2], 3)).toBe(2);
    });

    test('another card\'s list starts at its first greeting', () => {
        expect(selectedGreetingIndex({ owner: 'a.png', index: 2, id: 30 }, 'b.png', [10, 20, 30], 3)).toBe(0);
        expect(selectedGreetingIndex({ owner: null, index: 2, id: undefined }, 'a.png', [10, 20, 30], 3)).toBe(0);
    });
});

describe('pagerSelection', () => {
    test('another card starts at the greeting the tab keeps shown for it', () => {
        const kept = pagerSelection({ owner: 'a.png', index: 0, id: 1 }, 'b.png', { id: 9 });
        expect(kept).toEqual({ owner: 'b.png', index: 0, id: 9 });
        expect(selectedGreetingIndex(kept, 'b.png', [7, 8, 9], 3)).toBe(2);
        expect(selectedGreetingIndex(kept, 'b.png', [8, 7], 2)).toBe(0);
    });

    test('the same card keeps what the pager shows; a card with none kept starts at its first', () => {
        expect(pagerSelection({ owner: 'b.png', index: 1, id: 8 }, 'b.png', { id: 9 })).toEqual({ owner: 'b.png', index: 1, id: 8 });
        const none = pagerSelection({ owner: 'a.png', index: 2, id: 1 }, 'b.png', undefined);
        expect(selectedGreetingIndex(none, 'b.png', [7, 8, 9], 3)).toBe(0);
    });
});
