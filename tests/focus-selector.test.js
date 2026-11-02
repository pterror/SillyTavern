import { describe, test, expect } from '@jest/globals';
import { focusCounterpart, splitSelectorList } from '../public/scripts/focus-selector.js';

describe('focusCounterpart', () => {
    test('a plain hover reads as keyboard focus', () => {
        expect(focusCounterpart('.menu_button:hover')).toBe('.menu_button:focus-visible');
    });

    test('a compound keeps its other parts', () => {
        expect(focusCounterpart('button.menu_button[data-x="a:hover"]:hover:not(.disabled)'))
            .toBe('button.menu_button[data-x="a:hover"]:focus-visible:not(.disabled)');
    });

    test('a descendant of a hovered element: the hovered one is the focused one', () => {
        expect(focusCounterpart('.mes:hover .mes_buttons')).toBe('.mes:focus-visible .mes_buttons');
    });

    test('only a negated hover has no counterpart', () => {
        expect(focusCounterpart('.mes:not(:hover) .lore-mark')).toBeNull();
        expect(focusCounterpart(':not(.a:hover)')).toBeNull();
    });

    test('a hover inside :not beside a hover outside it reads as focus on both sides', () => {
        expect(focusCounterpart('&:hover:not(:has(.argument-name:hover, .argument-types:hover))'))
            .toBe('&:focus-visible:not(:has(.argument-name:focus-visible, .argument-types:focus-visible))');
    });

    test('a hover inside :has is the focus inside it', () => {
        expect(focusCounterpart('#tagList .tag:has(.tag_remove:hover) .tag_name'))
            .toBe('#tagList .tag:has(.tag_remove:focus-visible) .tag_name');
    });

    test('a double negation is a hover again', () => {
        expect(focusCounterpart('.a:not(:not(:hover))')).toBe('.a:not(:not(:focus-visible))');
    });

    test('a hover inside a pseudo-class it cannot read has no counterpart', () => {
        expect(focusCounterpart('li:nth-child(2 of .x:hover)')).toBeNull();
    });

    test('names that only start with hover are left alone', () => {
        expect(focusCounterpart('.a:hover-ish')).toBeNull();
    });

    test('no hover, no counterpart', () => {
        expect(focusCounterpart('.a .b')).toBeNull();
    });
});

describe('splitSelectorList', () => {
    test('splits at top-level commas only', () => {
        expect(splitSelectorList('.a:hover, :is(.b, .c):hover, [data-x="1,2"]:hover'))
            .toEqual(['.a:hover', ':is(.b, .c):hover', '[data-x="1,2"]:hover']);
    });

    test('each selector of a list is translated on its own', () => {
        expect(splitSelectorList('.a:hover, .b, .c:not(:hover)').map(focusCounterpart))
            .toEqual(['.a:focus-visible', null, null]);
    });
});
