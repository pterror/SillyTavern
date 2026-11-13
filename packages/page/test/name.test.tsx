import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { expect, test } from 'vite-plus/test';
import type { Named } from '@st/protocol/looks';
import { Name, inlineName, nameElement } from '../src/name.tsx';

const ilse: Named = { thing: '42', text: 'Ilse Varro', shownAs: 'name' };

test("a name is its look's box around one span with the thing's class, following the label", () => {
    const host = document.createElement('div');
    const [named, setNamed] = createSignal<Named>(ilse);
    const dispose = render(() => <Name named={named()} />, host);
    const box = host.firstElementChild;
    const span = box?.firstElementChild;
    expect(host.children).toHaveLength(1);
    expect(box?.className).toBe('name-box look-box-42');
    expect(box?.children).toHaveLength(1);
    expect(span?.className).toBe('named named-name look-42');
    expect(span?.getAttribute('data-thing')).toBe('42');
    expect(span?.textContent).toBe('Ilse Varro');
    expect(span?.getAttribute('style')).toBeNull();
    setNamed({ thing: '43', text: 'The tide goes out', shownAs: 'opening' });
    expect(host.firstElementChild).toBe(box);
    expect(box?.className).toBe('name-box look-box-43');
    expect(span?.className).toBe('named named-opening look-43');
    expect(span?.textContent).toBe('The tide goes out');
    dispose();
});

test('a place with a picture puts it on both sides, outside the name span, and selection marks the span', () => {
    const host = document.createElement('div');
    const [selected, setSelected] = createSignal(false);
    const dispose = render(() => <Name named={ilse} picture="/thumb/ilse.png" selected={selected()} />, host);
    const box = host.firstElementChild as HTMLElement;
    expect([...box.children].map((c) => c.className)).toEqual([
        'name-picture name-picture-before',
        'named named-name look-42',
        'name-picture name-picture-after',
    ]);
    expect(box.querySelector('.name-picture')?.getAttribute('style')).toBe('--name-picture: url("/thumb/ilse.png");');
    expect(box.querySelector('.named')?.hasAttribute('data-selected')).toBe(false);
    setSelected(true);
    expect(box.querySelector('.named')?.hasAttribute('data-selected')).toBe(true);
    dispose();
});

const shape = (node: Element): unknown => ({
    tag: node.tagName,
    attributes: Object.fromEntries([...node.attributes].map((a) => [a.name, a.value])),
    text: node.children.length === 0 ? node.textContent : null,
    children: [...node.children].map(shape),
});

test('the plain-DOM form draws the same markup as the component', () => {
    for (const options of [
        {},
        { picture: '/thumb/ilse.png' },
        { selected: true },
        { picture: '/p.png', selected: true },
    ]) {
        const host = document.createElement('div');
        const dispose = render(() => <Name named={ilse} {...options} />, host);
        expect(shape(nameElement(ilse, options))).toEqual(shape(host.firstElementChild as Element));
        dispose();
    }
});

test("a name written in a text is wrapped in its look's box, which carries its picture, around the name's own span", () => {
    expect(inlineName('42', '/look-images/a.png')).toEqual([
        {
            class: 'name-box look-box-42 name-inline',
            attributes: { style: '--name-picture: url("/look-images/a.png")' },
        },
        { class: 'named named-name look-42', attributes: { 'data-thing': '42' } },
    ]);
    expect(inlineName('42', null)[0].attributes).toEqual({});
});
