import { describe, test, expect } from '@jest/globals';
import { Window } from 'happy-dom';
import { marked } from 'marked';
import { renderMarked } from '../public/scripts/lore-mark-render.js';

const doc = new Window().document;

/** @param {string} text */
const markdown = text => String(marked.parse(text)).trim();

/**
 * @param {string} html
 * @returns {{ text: string, entries: string }[]}
 */
function marksIn(html) {
    const host = doc.createElement('div');
    host.innerHTML = html;
    return [...host.querySelectorAll('.lore-mark')].map(m => ({ text: m.textContent ?? '', entries: m.getAttribute('data-lore') ?? '' }));
}

/** @param {string} html */
function textOf(html) {
    const host = doc.createElement('div');
    host.innerHTML = html;
    return host.textContent;
}

/**
 * @param {string} text
 * @param {string} word
 * @param {number} entry
 */
const spanOf = (text, word, entry = 0) => ({ from: text.indexOf(word), to: text.indexOf(word) + word.length, entries: [entry] });

describe('lore marks on rendered text', () => {
    test('marks land on the stored words through markdown, and the text is unchanged', () => {
        const text = 'She lit the *old lantern* by the **harbour** gate.';
        const { html, drawn } = renderMarked(text, [spanOf(text, 'lantern'), spanOf(text, 'harbour', 1)], markdown, doc);
        expect(drawn).toBe(2);
        expect(marksIn(html)).toEqual([{ text: 'lantern', entries: '0' }, { text: 'harbour', entries: '1' }]);
        expect(textOf(html)).toBe(textOf(markdown(text)));
        expect(html).toContain('<em>old <span class="lore-mark" data-lore="0">lantern</span></em>');
    });

    test('a span across an emphasis boundary is drawn as one mark per piece', () => {
        const text = 'the old *lantern room*';
        const { html } = renderMarked(text, [{ from: text.indexOf('old'), to: text.indexOf(' room'), entries: [2] }], markdown, doc);
        expect(marksIn(html).map(m => m.text)).toEqual(['old ', 'lantern']);
    });

    test('overlapping spans carry every entry on the shared words', () => {
        const text = 'the lantern keeper';
        const { html } = renderMarked(text, [spanOf(text, 'lantern keeper', 0), spanOf(text, 'lantern', 1)], markdown, doc);
        expect(marksIn(html)).toEqual([{ text: 'lantern', entries: '0 1' }, { text: ' keeper', entries: '0' }]);
    });

    test('a regex display script that rewrites the words keeps marks on what it left in place', () => {
        const text = 'Elara waved at the lantern.';
        const script = (/** @type {string} */ t) => markdown(t.replace(/waved/g, 'nodded'));
        const { html, drawn } = renderMarked(text, [spanOf(text, 'Elara'), spanOf(text, 'lantern', 1)], script, doc);
        expect(drawn).toBe(2);
        expect(marksIn(html).map(m => m.text)).toEqual(['Elara', 'lantern']);
        expect(textOf(html)).toBe('Elara nodded at the lantern.');
    });

    test('a regex display script whose match a mark would split draws nothing, never a mark in the wrong place', () => {
        const text = 'the old lantern';
        const script = (/** @type {string} */ t) => markdown(t.replace(/old lantern/g, 'brass lamp'));
        const { html, drawn } = renderMarked(text, [spanOf(text, 'lantern')], script, doc);
        expect(drawn).toBe(0);
        expect(html).toBe(script(text));
    });

    test('a macro the span covers part of draws nothing; one beside it keeps its mark', () => {
        const macros = (/** @type {string} */ t) => markdown(t.replaceAll('{{char}}', 'Seraphina'));
        const text = '{{char}} holds the lantern.';
        const inside = renderMarked(text, [{ from: 2, to: 6, entries: [0] }], macros, doc);
        expect(inside.drawn).toBe(0);
        expect(inside.html).toBe(macros(text));
        const beside = renderMarked(text, [spanOf(text, 'lantern')], macros, doc);
        expect(marksIn(beside.html)).toEqual([{ text: 'lantern', entries: '0' }]);
        expect(textOf(beside.html)).toBe('Seraphina holds the lantern.');
    });

    test('a span inside a link target is not drawn; one in the link text is', () => {
        const text = 'see [the lantern](https://example.com/lantern)';
        const at = text.lastIndexOf('lantern');
        const { html } = renderMarked(text, [{ from: at, to: at + 7, entries: [0] }, spanOf(text, 'lantern', 1)], markdown, doc);
        expect(marksIn(html)).toEqual([{ text: 'lantern', entries: '1' }]);
        expect(html).toContain('href="https://example.com/lantern"');
    });

    test('text that already holds private-use characters, or spans outside the text, draw nothing', () => {
        const text = 'the lantern ';
        expect(renderMarked(text, [spanOf(text, 'lantern')], markdown, doc).drawn).toBe(0);
        expect(renderMarked('short', [{ from: 2, to: 99, entries: [0] }], markdown, doc).drawn).toBe(0);
    });
});
