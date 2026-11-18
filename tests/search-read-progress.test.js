import { describe, test, expect } from '@jest/globals';
import { Window } from 'happy-dom';
import { SearchReadProgress, searchReadDivider, unreadDividerPoints, unreadDividerSegments } from '../public/scripts/search-read-progress.js';

describe('newest-first search read progress', () => {
    test('new results extend the unread prefix above the old read results', () => {
        const progress = new SearchReadProgress([['old', 0]]);
        expect(progress.boundary(['new', 'old'])).toBe(1);
        expect(progress.boundary(['old'])).toBe(-1);
    });

    test('Alt-click marks the clicked card and newer cards unread, retaining older cards', () => {
        const progress = new SearchReadProgress([['newer-page', 0], ['older-page', 50]]);
        progress.unreadThrough(['a', 'b', 'c'], 1, 10);
        expect([...progress.seen.keys()]).toEqual(['older-page', 'c']);
        expect(progress.boundary(['a', 'b', 'c'])).toBe(2);
    });

    test('all unread results put the boundary after the last result', () => {
        expect(new SearchReadProgress().boundary(['a', 'b'])).toBe(2);
    });
});

test('divider survives a refetch and Alt-click does not activate the result', () => {
    const browser = new Window();
    const previous = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, IntersectionObserver: globalThis.IntersectionObserver };
    Object.assign(globalThis, {
        window: browser, document: browser.document, HTMLElement: browser.HTMLElement,
        IntersectionObserver: class { observe() {} disconnect() {} },
    });
    try {
        const stored = new Map();
        const draw = searchReadDivider({ getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) }, () => true, () => 'Unread');
        const list = browser.document.createElement('div');
        browser.document.body.append(list);
        const render = () => {
            list.innerHTML = '<div data-search-result-id="character:a">A</div><div data-search-result-id="character:b">B</div>';
            draw(list, 'search', 0);
        };
        render();
        const row = list.querySelector('[data-search-result-id="character:a"]');
        let activated = false;
        row.addEventListener('click', () => { activated = true; });
        row.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));
        expect(activated).toBe(false);
        expect(row.nextElementSibling.firstElementChild.className).toBe('search_unread_divider');
        expect(list.children.length).toBe(2);
        expect(list.querySelector('.search_unread_label').textContent).toBe('Unread');
        render();
        expect(list.querySelector('.search_unread_divider')).not.toBeNull();
        draw(list, '', 0);
        expect(list.querySelector('.search_unread_divider')).toBeNull();
    } finally {
        browser.close();
        Object.assign(globalThis, previous);
    }
});


test('only catching up advances the boundary; partial scrolling and refetching preserve it', () => {
    const browser = new Window();
    const previous = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, IntersectionObserver: globalThis.IntersectionObserver };
    let intersect;
    Object.assign(globalThis, {
        window: browser, document: browser.document, HTMLElement: browser.HTMLElement,
        IntersectionObserver: class {
            constructor(callback) { intersect = () => callback([{ isIntersecting: true }]); }
            observe() {} disconnect() {}
        },
    });
    try {
        const stored = new Map();
        const draw = searchReadDivider({ getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) }, () => true, () => 'Unread');
        const list = browser.document.createElement('div');
        browser.document.body.append(list);
        Object.defineProperties(list, { clientHeight: { value: 100 }, scrollHeight: { value: 500 } });
        Object.defineProperty(browser.document, 'visibilityState', { value: 'visible' });
        const render = () => {
            list.innerHTML = '<div data-search-result-id="character:a">A</div><div data-search-result-id="character:b">B</div>';
            draw(list, 'query', 0);
        };
        render();
        list.scrollTop = 200;
        list.dispatchEvent(new browser.Event('scroll'));
        render();
        expect(list.querySelector('.search_unread_divider')).not.toBeNull();
        list.scrollTop = 0;
        intersect();
        expect(list.querySelector('.search_unread_divider')).toBeNull();
        render();
        expect(list.querySelector('.search_unread_divider')).toBeNull();
        list.lastElementChild.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, altKey: true }));
        render();
        intersect();
        expect(list.querySelector('.search_unread_divider')).not.toBeNull();
        list.scrollTop = 200;
        list.dispatchEvent(new browser.Event('scroll'));
        list.scrollTop = 0;
        list.dispatchEvent(new browser.Event('scroll'));
        expect(list.querySelector('.search_unread_divider')).toBeNull();
        draw(list, '', 0);
    } finally {
        browser.close();
        Object.assign(globalThis, previous);
    }
});


describe('stepped unread divider geometry', () => {
    const boxes = [
        { left: 10, right: 100, top: 10, bottom: 90 },
        { left: 110, right: 200, top: 10, bottom: 100 },
        { left: 210, right: 300, top: 10, bottom: 95 },
        { left: 10, right: 100, top: 110, bottom: 190 },
    ];

    test('splits a row with a connected line below read cards and above unread cards', () => {
        expect(unreadDividerPoints(boxes, 1, 5, 305)).toEqual([
            [5, 105], [105, 105], [105, 10], [305, 10],
        ]);
    });

    test('uses one full-width line at the beginning of a row', () => {
        expect(unreadDividerPoints(boxes, 0, 5, 305)).toEqual([[5, 10], [305, 10]]);
        expect(unreadDividerPoints(boxes, 3, 5, 305)).toEqual([[5, 105], [305, 105]]);
    });

    test('adapts to a resized single-column list', () => {
        const stacked = boxes.map((box, index) => ({ ...box, left: 10, right: 300, top: index * 100 + 10, bottom: index * 100 + 90 }));
        expect(unreadDividerPoints(stacked, 1, 5, 305)).toEqual([[5, 100], [305, 100]]);
    });
});


test('caption gap cuts both the horizontal line and an intersecting vertical step', () => {
    expect(unreadDividerSegments([[0, 100], [100, 100], [100, 0], [300, 0]], {
        left: 80, right: 120, top: -10, bottom: 10,
    })).toEqual([
        [[0, 100], [100, 100]],
        [[100, 10], [100, 100]],
        [[120, 0], [300, 0]],
    ]);
    expect(unreadDividerSegments([[0, 0], [300, 0]], {
        left: 130, right: 170, top: -10, bottom: 10,
    })).toEqual([[[0, 0], [130, 0]], [[170, 0], [300, 0]]]);
});
