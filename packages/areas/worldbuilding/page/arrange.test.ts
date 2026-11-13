import { expect, test } from 'vite-plus/test';
import type { FoundEntry, RelationOnCard } from '../protocol.ts';
import { slotAt } from './Drag.tsx';
import { whereItSits } from './Picker.tsx';
import { wordsOf } from './Selection.tsx';

const rect = (left: number, top: number) => new DOMRect(left, top, 100, 50);

// Two rows of two cards: a, b over c, d.
const cells = [
    { entry: 'a', rect: rect(0, 0) },
    { entry: 'b', rect: rect(110, 0) },
    { entry: 'c', rect: rect(0, 60) },
    { entry: 'd', rect: rect(110, 60) },
];

test('a drop lands before the first cell the point is above or left of the middle of, the dragged one left out', () => {
    expect(slotAt(cells, 20, 20, 'x')).toEqual({ after: null, before: 'a' });
    expect(slotAt(cells, 80, 20, 'x')).toEqual({ after: 'a', before: 'b' });
    expect(slotAt(cells, 200, 20, 'x')).toEqual({ after: 'b', before: 'c' });
    expect(slotAt(cells, 130, 80, 'x')).toEqual({ after: 'c', before: 'd' });
    expect(slotAt(cells, 200, 200, 'x')).toEqual({ after: 'd', before: null });
    expect(slotAt(cells, 130, 80, 'c')).toEqual({ after: 'b', before: 'd' });
    expect(slotAt([], 0, 0, 'x')).toEqual({ after: null, before: null });
});

test('selected words become a key with their white space run together and none around them', () => {
    expect(wordsOf('  the Salt\n  Wives ')).toBe('the Salt Wives');
    expect(wordsOf(' \n ')).toBe('');
});

const relation = (kind: string, target: string, deleted = false): RelationOnCard => ({
    kind,
    kindName: kind === '1' ? 'in' : 'owes',
    targetKey: '1',
    targetEntry: target,
    target: deleted ? null : { thing: target, text: target === '9' ? 'Saltmarrow' : 'The Pale Choir', shownAs: 'name' },
    targetDeleted: deleted,
    inUse: !deleted,
    weak: false,
});

test('a found entry says where it sits under the grouping kind, from its first live relation of that kind', () => {
    const found: FoundEntry = {
        label: { thing: '3', text: 'The Lantern House', shownAs: 'name' },
        picture: null,
        relations: [relation('2', '8'), relation('1', '7', true), relation('1', '9')],
    };
    expect(whereItSits(found, '1')).toBe('in Saltmarrow');
    expect(whereItSits(found, '2')).toBe('owes The Pale Choir');
    expect(whereItSits(found, '5')).toBe('');
    expect(whereItSits(found, null)).toBe('');
});
