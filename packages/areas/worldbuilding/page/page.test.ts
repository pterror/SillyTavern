import { expect, test } from 'vite-plus/test';
import { MAX_CARDS_PER_READ, readFitsTheBudget } from '../protocol.ts';
import { gistOf } from './Cards.tsx';
import { pageLayout, topLevelShown } from './layout.ts';
import { chanceOf, comesOf } from './Placement.tsx';
import { NOTHING_TYPED, filterOf } from './Search.tsx';
import { paragraphsOf } from './Text.tsx';

test('a text is drawn as its paragraphs, each its plain words and its linked names, the links cut at paragraph ends', () => {
    const text = 'Ilse keeps the Lantern House.\n\nThe Pale Choir sings.\nAt low water.';
    const links = [
        { entry: '2', from: 15, to: 28, picture: null },
        { entry: '1', from: 0, to: 4, picture: '/look-images/a' },
        { entry: '3', from: 31, to: 45, picture: null },
    ];
    expect(paragraphsOf(text, links)).toEqual([
        [
            { text: 'Ilse', link: '1', picture: '/look-images/a' },
            { text: ' keeps the ', link: null },
            { text: 'Lantern House', link: '2', picture: null },
            { text: '.', link: null },
        ],
        [
            { text: 'The Pale Choir', link: '3', picture: null },
            { text: ' sings.\nAt low water.', link: null },
        ],
    ]);
    expect(paragraphsOf('', [])).toEqual([]);
});

test('a card says the first paragraph of the text, and nothing when its name already is the opening', () => {
    expect(gistOf({ label: { thing: '1', text: 'Ilse', shownAs: 'name' }, text: '\nFirst line.\nSecond.' })).toBe(
        'First line.',
    );
    expect(gistOf({ label: { thing: '1', text: 'Bells ring', shownAs: 'opening' }, text: 'Bells ring.' })).toBe('');
});

test('the prompt sentence reads when an entry comes in and how often from upstream fields', () => {
    expect(comesOf({ constant: false, disable: false })).toBe('brought up');
    expect(comesOf({ constant: true, disable: false })).toBe('always');
    expect(comesOf({ constant: true, disable: true })).toBe('never');
    expect(chanceOf({ probability: 50, useProbability: true })).toBe(50);
    expect(chanceOf({ probability: 50, useProbability: false })).toBe(100);
});

test('the layout fits the page width, and a read never asks for more cards than the budget', () => {
    const wide = pageLayout(1280);
    expect(wide.columns).toBe(3);
    expect(wide.overview.regionsByNestingLevel).toEqual([
        { columns: 3, rows: 2 },
        { columns: 3, rows: 2 },
    ]);
    expect(pageLayout(390).columns).toBe(1);
    for (const width of [390, 800, 1280, 4000]) {
        const layout = pageLayout(width);
        const shown = topLevelShown(layout);
        expect(shown).toBeGreaterThan(0);
        expect(readFitsTheBudget(shown, layout.overview)).toBe(true);
        expect(shown).toBeLessThanOrEqual(MAX_CARDS_PER_READ);
    }
});

test('what is typed in the search box is sent whole: the words and the region it is scoped to', () => {
    expect(filterOf(NOTHING_TYPED)).toEqual({ query: '', chips: [] });
    const chip = { kind: '1', target: '7', depth: 'anyDepth' as const };
    expect(filterOf({ query: 'lan', scope: { chip, label: 'Saltmarrow' } })).toEqual({ query: 'lan', chips: [chip] });
});
