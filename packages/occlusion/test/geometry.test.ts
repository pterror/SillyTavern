import { describe, expect, test } from 'vite-plus/test';
import { clipPathFor, disjointRects, holesIn, insetBox, squared, uncoveredPieces, unionArea } from '../src/geometry.ts';
import { hideWhenCovered, hideWhenSplit, squareCorners, exempt } from '../src/policies.ts';
import type { Rect } from '../src/geometry.ts';

const box = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });

describe('geometry', () => {
    test('disjoint rects cover each point once', () => {
        const parts = disjointRects([box(0, 0, 10, 10), box(5, 5, 15, 15)]);
        expect(unionArea(parts)).toBe(175);
        expect(unionArea([box(0, 0, 10, 10), box(0, 0, 10, 10)])).toBe(100);
    });

    test('holes are the covers inside the box, in its coordinates; corners stay round only inside it', () => {
        const r: Rect = {
            ...box(50, 50, 150, 150),
            radii: [
                [10, 10],
                [10, 10],
                [10, 10],
                [10, 10],
            ],
        };
        const [hole] = holesIn(box(100, 0, 300, 300), [r]);
        expect(hole).toEqual({
            left: 0,
            top: 50,
            right: 50,
            bottom: 150,
            radii: [
                [0, 0],
                [10, 10],
                [10, 10],
                [0, 0],
            ],
        });
        expect(holesIn(box(0, 0, 10, 10), [box(20, 20, 30, 30)])).toEqual([]);
        expect(squared([r])).toEqual([box(50, 50, 150, 150)]);
    });

    test('the clip-path is empty for no holes and an evenodd polygon otherwise', () => {
        expect(clipPathFor([])).toBe('');
        expect(clipPathFor([box(1, 2, 3, 4)])).toBe(
            'polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, 1px 2px, 3px 2px, 3px 4px, 1px 4px, 1px 2px, 0 0)',
        );
    });

    test('a column down the middle leaves two pieces; slivers and specks do not count', () => {
        expect(uncoveredPieces(300, 100, [box(100, 0, 200, 100)])).toBe(2);
        expect(uncoveredPieces(300, 100, [box(0, 0, 298, 100)])).toBe(0);
        expect(uncoveredPieces(300, 100, [box(0, 0, 200, 100)])).toBe(1);
    });

    test('an inset() clip-path trims the box; other clip-paths leave it', () => {
        expect(insetBox(box(0, 0, 100, 200), 'inset(0px 0px 50% 0px)')).toEqual(box(0, 0, 100, 100));
        expect(insetBox(box(0, 0, 100, 200), 'inset(0px 0px 100% 0px)')).toBeNull();
        expect(insetBox(box(0, 0, 100, 200), 'none')).toEqual(box(0, 0, 100, 200));
    });
});

describe('policies', () => {
    const el = {} as Element;
    const target = { el, box: box(0, 0, 300, 100) };
    test('hidden when covered whole, not before', () => {
        const policy = hideWhenCovered(() => true);
        expect(policy.hides?.([box(0, 0, 300, 100)], target)).toBe(true);
        expect(policy.hides?.([box(0, 0, 299, 100)], target)).toBe(false);
    });

    test('hidden when one hole splits it, not when the holes only together would', () => {
        const policy = hideWhenSplit(() => true);
        expect(policy.hides?.([box(100, 0, 200, 100)], target)).toBe(true);
        expect(policy.hides?.([box(100, 0, 200, 50), box(100, 50, 200, 100)], target)).toBe(false);
    });

    test('exempt leaves no holes; square corners drops the radii', () => {
        const round: Rect = {
            ...box(0, 0, 10, 10),
            radii: [
                [2, 2],
                [2, 2],
                [2, 2],
                [2, 2],
            ],
        };
        expect(exempt(() => true).holes?.([round], target)).toEqual([]);
        expect(squareCorners(() => true).holes?.([round], target)).toEqual([box(0, 0, 10, 10)]);
    });
});
