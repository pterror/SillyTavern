import { render } from 'solid-js/web';
import { expect, test } from 'vite-plus/test';
import type { Client } from '@st/page/client';
import { UiProvider } from '@st/page/context';
import type { LookState } from '@st/protocol/looks';
import type { LookView, Shown } from '../protocol.ts';
import { changeOf, filterParts, readEffect, withoutEffect } from './effects.ts';
import { LookScreen, glyphDeclarations, supplierOf } from './LookScreen.tsx';

const layer = (entries: [string, string][]) => new Map(entries);

test('glow, shadow and blur are parts of one filter: writing one keeps the others', () => {
    const shown = layer([['filter', 'blur(0.5px) drop-shadow(2px 2px 3px #000000)']]);
    expect(readEffect('glow', shown)).toBe(null);
    expect(readEffect('shadow', shown)).toEqual({ color: '#000000', distance: 2, softness: 3 });
    expect(changeOf('glow', shown, { color: '#ffd27a', size: 12 })).toEqual({
        set: [
            { property: 'filter', value: 'blur(0.5px) drop-shadow(0 0 12px #ffd27a) drop-shadow(2px 2px 3px #000000)' },
        ],
        cleared: [],
    });
    expect(withoutEffect('shadow', shown)).toEqual({ set: [{ property: 'filter', value: 'blur(0.5px)' }], reset: [] });
    expect(withoutEffect('blur', layer([['filter', 'blur(1px)']]))).toEqual({ set: [], reset: ['filter'] });
    expect(filterParts('none')).toEqual({});
});

test('a gradient color reads back as its stops and direction; going back to one color clears what only the gradient wrote', () => {
    const gradient = layer([
        ['color', '#f6cf86'],
        ['background-image', 'linear-gradient(90deg, #f6cf86, #ec8f6f)'],
        ['background-clip', 'text'],
        ['-webkit-background-clip', 'text'],
        ['-webkit-text-fill-color', 'transparent'],
    ]);
    expect(readEffect('color', gradient)).toEqual({ mode: 'gradient', angle: 90, stops: ['#f6cf86', '#ec8f6f'] });
    const change = changeOf('color', gradient, { mode: 'solid', color: '#b9d9a3' });
    expect(change.set).toEqual([{ property: 'color', value: '#b9d9a3' }]);
    expect(change.cleared.sort()).toEqual(
        ['-webkit-background-clip', '-webkit-text-fill-color', 'background-clip', 'background-image'].sort(),
    );
});

test('a tool draws its letter with the effect as the state shows it, or as it would be turned on', () => {
    expect(glyphDeclarations('glow', layer([]))).toEqual([
        { property: 'color', value: 'currentColor' },
        { property: 'filter', value: 'drop-shadow(0 0 6px #f0965a)' },
    ]);
    expect(glyphDeclarations('color', layer([['color', 'teal']]))).toEqual([{ property: 'color', value: 'teal' }]);
});

const shownAt = (property: string, value: string, state: LookState, level: number): Shown => ({
    property,
    value,
    state,
    level,
});

test('an effect is edited where the state sets it, else on the thing itself', () => {
    const shown = [shownAt('filter', 'drop-shadow(0 0 4px #9cc3f0)', 'wordPointed', 0)];
    expect(supplierOf('glow', 'wordPointed', shown, 2)).toBe(0);
    expect(supplierOf('glow', 'selected', shown, 2)).toBe(2);
    expect(supplierOf('color', 'wordPointed', shown, 2)).toBe(2);
});

const VIEW: LookView = {
    thing: '7',
    kind: 'entry',
    world: '1',
    named: { thing: '7', text: 'Ilse Varro', shownAs: 'name' },
    picture: { own: null, image: null, crop: null },
    levels: [
        { kind: 'theme', level: { theme: true } },
        { kind: 'world', level: { thing: '1' }, name: 'The Drowned Coast' },
        { kind: 'shared', level: { shared: { id: 'a', world: '1' } }, name: 'Lantern House regulars', by: 'thing' },
        { kind: 'thing', level: { thing: '7' } },
    ],
    shown: {
        rest: [shownAt('color', '#ffcf7a', 'rest', 2)],
        messagePointed: [shownAt('color', '#ffcf7a', 'rest', 2)],
        wordPointed: [
            shownAt('color', '#ffcf7a', 'rest', 2),
            shownAt('filter', 'drop-shadow(0 0 12px #ffd27a)', 'wordPointed', 3),
        ],
        selected: [
            shownAt('color', '#ffcf7a', 'rest', 2),
            shownAt('filter', 'drop-shadow(0 0 12px #ffd27a)', 'wordPointed', 3),
        ],
    },
    placement: { before: null, after: null, note: { value: 'the innkeeper', level: 3 } },
    own: { wordPointed: [{ property: 'filter', value: 'drop-shadow(0 0 12px #ffd27a)' }], note: 'the innkeeper' },
    uses: [{ id: 'a', world: '1', name: 'Lantern House regulars', look: {} }],
    available: [{ id: 'b', world: null, name: 'Soft glow' }],
    fonts: [{ id: 'noto-sans', name: 'Noto Sans', uploaded: false, family: 'Noto Sans', face: null }],
    mark: {
        stored: {},
        shown: {
            rest: { style: 'dotted', color: 'currentColor', opacity: 1 },
            messagePointed: { style: 'dotted', color: 'currentColor', opacity: 1 },
            wordPointed: { style: 'dotted', color: 'currentColor', opacity: 1 },
        },
    },
    looks: { styles: {}, things: {} },
};

function stand(view: LookView) {
    const sent: { type: string; payload: unknown }[] = [];
    const client: Client = {
        send: async (type, payload) => {
            sent.push({ type, payload });
            return { ok: true };
        },
        view: (() => () => view) as Client['view'],
        receive: () => {},
        reconnected: async () => {},
        reread: async () => {},
        version: () => 1,
    };
    const host = document.createElement('div');
    document.body.append(host);
    render(
        () => (
            <UiProvider value={{ client, t: (text) => text }}>
                <LookScreen />
            </UiProvider>
        ),
        host,
    );
    return { host, sent };
}

const byLabel = (host: HTMLElement, label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement;

test('the screen names the thing, its uses with where they live, and each state as a scene', () => {
    const { host } = stand(VIEW);
    expect(host.querySelector('.look-back')?.textContent).toBe('Ilse Varro');
    expect(host.querySelector('.look-uchip')?.textContent).toContain('Lantern House regulars');
    expect(host.querySelector('.look-uchip .look-uat')?.textContent).toBe('This world');
    expect([...host.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute('title'))).toEqual([
        'Normal',
        'Message hover',
        'Word hover or focus',
        'Selected',
    ]);
    expect((host.querySelector('.look-notein') as HTMLInputElement).value).toBe('the innkeeper');
});

test('a dim tool turns its effect on for just this name, in the state picked, with one action', () => {
    const { host, sent } = stand(VIEW);
    byLabel(host, 'Word hover or focus').click();
    const outline = byLabel(host, 'Outline');
    expect(outline.classList.contains('look-on')).toBe(false);
    outline.click();
    expect(sent).toEqual([
        {
            type: 'looks.setDeclarations',
            payload: {
                level: { thing: '7' },
                state: 'wordPointed',
                set: [
                    { property: '-webkit-text-stroke-width', value: '1px' },
                    { property: '-webkit-text-stroke-color', value: '#2a1208' },
                    { property: 'paint-order', value: 'stroke fill' },
                ],
                reset: [],
            },
        },
    ]);
});

test('Applies to lists the thing’s chain and moves the effect to the level chosen; Reset takes it off its level', () => {
    const { host, sent } = stand(VIEW);
    byLabel(host, 'Word hover or focus').click();
    byLabel(host, 'Glow').click();
    const scope = host.querySelector('select.look-scope') as HTMLSelectElement;
    expect([...scope.options].map((o) => o.textContent)).toEqual([
        'Every name',
        'Everything in The Drowned Coast',
        'Lantern House regulars',
        'Just Ilse Varro',
        'New for this world…',
        'New for all worlds…',
    ]);
    expect(scope.value).toBe('3');
    scope.value = '0';
    scope.dispatchEvent(new Event('change'));
    expect(sent.at(-1)).toEqual({
        type: 'looks.applyTo',
        payload: {
            thing: '7',
            what: { state: 'wordPointed', properties: ['filter'] },
            from: { thing: '7' },
            to: { theme: true },
        },
    });
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Reset')?.click();
    expect(sent.at(-1)).toEqual({
        type: 'looks.setDeclarations',
        payload: { level: { thing: '7' }, state: 'wordPointed', set: [], reset: ['filter'] },
    });
});

test('the CSS panel shows the controls’ lines apart and sends what is typed for the thing’s level', () => {
    const { host, sent } = stand(VIEW);
    byLabel(host, 'Word hover or focus').click();
    byLabel(host, 'CSS').click();
    expect(host.querySelector('.look-cssfx')?.textContent).toBe('filter: drop-shadow(0 0 12px #ffd27a);');
    const typed = host.querySelector('.look-cssta') as HTMLTextAreaElement;
    typed.value = 'word-spacing: 2px;';
    typed.dispatchEvent(new Event('change'));
    expect(sent.at(-1)).toEqual({
        type: 'looks.writeCss',
        payload: {
            thing: '7',
            state: 'wordPointed',
            css: 'word-spacing: 2px;',
            replaces: [],
            newAt: { thing: '7' },
        },
    });
});

test('+ shared look offers the looks not in use and uses the one picked', () => {
    const { host, sent } = stand(VIEW);
    (host.querySelector('.look-uadd') as HTMLElement).click();
    const items = [...host.querySelectorAll('.look-upop button')].map((b) => b.textContent);
    expect(items).toEqual(['Soft glowAll worlds', 'New for this world…', 'New for all worlds…']);
    (host.querySelector('.look-upop button') as HTMLElement).click();
    expect(sent.at(-1)).toEqual({ type: 'looks.use', payload: { thing: '7', shared: 'b', before: null } });
});

test('clicking the marked word opens the mark’s settings, which are the theme’s', () => {
    const { host, sent } = stand(VIEW);
    (host.querySelector('.look-mkbtn') as HTMLElement).click();
    expect(host.querySelector('.look-fixed')?.textContent).toBe('All worlds');
    ([...host.querySelectorAll('.look-seg button')].find((b) => b.textContent === 'Dashed') as HTMLElement).click();
    expect(sent.at(-1)).toEqual({ type: 'looks.setMark', payload: { change: { rest: { style: 'dashed' } } } });
});
