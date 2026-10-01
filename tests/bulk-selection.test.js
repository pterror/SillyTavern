import { describe, test, expect } from '@jest/globals';
import { emptySelection, isSelected, setOne, setRange, setAll, isEverything, isEmpty, countSelection, selectionToWire } from '../public/scripts/bulk-selection.js';

// The character list's bulk selection held as rules over the list: picking and leaving out one by one, ranges of
// positions, and "everything", combined so that what the page shows selected is what the server is told.

const LIST = { filter: { includeGroups: true }, sort: { field: 'name', order: 'asc' } };

describe('bulk selection', () => {
    test('picking one by one selects exactly those, and the count is exact', () => {
        const selection = emptySelection();
        setOne(selection, 'a.png', 0, true);
        setOne(selection, 'b.png', 1, true);
        setOne(selection, 'a.png', 0, false);
        expect(isSelected(selection, 'a.png', 0)).toBe(false);
        expect(isSelected(selection, 'b.png', 1)).toBe(true);
        expect(countSelection(selection, 100)).toEqual({ count: 1, approx: false });
        expect(selectionToWire(selection, LIST)).toEqual({ query: undefined, all: false, ranges: [], excludeRanges: [], include: ['b.png'], exclude: [] });
    });

    test('a range selects every position in it, rows not drawn included, and merges with a neighbour', () => {
        const selection = emptySelection();
        setRange(selection, 10, 5, true);
        setRange(selection, 11, 20, true);
        expect(selection.ranges).toEqual([[5, 20]]);
        expect(isSelected(selection, 'x.png', 15)).toBe(true);
        expect(isSelected(selection, 'x.png', 21)).toBe(false);
        expect(countSelection(selection, 100)).toEqual({ count: 16, approx: true });
    });

    test('leaving one out of a range, then picking it again, ends where it started', () => {
        const selection = emptySelection();
        setRange(selection, 0, 9, true);
        setOne(selection, 'c.png', 3, false);
        expect(isSelected(selection, 'c.png', 3)).toBe(false);
        expect(selection.exclude.has('c.png')).toBe(true);
        setOne(selection, 'c.png', 3, true);
        expect(isSelected(selection, 'c.png', 3)).toBe(true);
        expect(selection.exclude.size).toBe(0);
        expect(selection.include.size).toBe(0);
    });

    test('a range decides the characters picked or left out inside it', () => {
        const selection = emptySelection();
        setOne(selection, 'in.png', 4, true);
        setOne(selection, 'out.png', 50, true);
        setRange(selection, 0, 9, true);
        expect(selection.include.has('in.png')).toBe(false);
        expect(selection.include.has('out.png')).toBe(true);
        setRange(selection, 0, 9, false);
        expect(selection.ranges).toEqual([]);
        expect(isSelected(selection, 'in.png', 4)).toBe(false);
    });

    test('everything, less a range and one left out, plus one picked back inside that range', () => {
        const selection = emptySelection();
        setAll(selection, true);
        expect(isEverything(selection)).toBe(true);
        setRange(selection, 0, 4, false);
        setOne(selection, 'back.png', 2, true);
        setOne(selection, 'gone.png', 30, false);
        expect(isEverything(selection)).toBe(false);
        expect(isSelected(selection, 'x.png', 1)).toBe(false);
        expect(isSelected(selection, 'back.png', 2)).toBe(true);
        expect(isSelected(selection, 'gone.png', 30)).toBe(false);
        expect(isSelected(selection, 'y.png', 40)).toBe(true);
        expect(countSelection(selection, 100)).toEqual({ count: 100 - 5 - 1 + 1, approx: true });
        expect(selectionToWire(selection, LIST)).toEqual({ query: LIST, all: true, ranges: [], excludeRanges: [[0, 4]], include: ['back.png'], exclude: ['gone.png'] });
    });

    test('nothing selected is empty; clearing everything leaves nothing', () => {
        const selection = emptySelection();
        expect(isEmpty(selection)).toBe(true);
        setAll(selection, true);
        expect(isEmpty(selection)).toBe(false);
        setAll(selection, false);
        expect(isEmpty(selection)).toBe(true);
        expect(isSelected(selection, 'a.png', 0)).toBe(false);
    });

    test('a row with no known position is picked by name', () => {
        const selection = emptySelection();
        setOne(selection, 'a.png', NaN, true);
        expect(isSelected(selection, 'a.png', NaN)).toBe(true);
        setRange(selection, 0, 9, true);
        expect(selection.include.has('a.png')).toBe(true);
    });
});
