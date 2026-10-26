import { createSignal } from 'solid-js';
import { expect, test } from 'vite-plus/test';
import { For, Show, render } from '../src/solid.ts';

// What JSX through `h` (packages/jsx) must do, which Solid's own h runtime didn't: several components side by side
// in one element follow their state, and what a <Show> hides comes back built anew.

test('components side by side in one element each follow their state', () => {
    const host = document.createElement('div');
    const [open, setOpen] = createSignal<string | null>(null);
    render(
        () => (
            <div>
                <Show when={() => open() === null}>{() => <p class="grid">grid</p>}</Show>
                <Show when={open}>{(name) => <p class="crumb">{name}</p>}</Show>
            </div>
        ),
        host,
    );
    expect(host.querySelectorAll('.grid').length).toBe(1);
    setOpen('a');
    expect(host.querySelector('.crumb')?.textContent).toBe('a');
    expect(host.querySelectorAll('.grid').length).toBe(0);
    setOpen(null);
    expect(host.querySelectorAll('.grid').length).toBe(1);
    expect(host.querySelectorAll('.crumb').length).toBe(0);
    // In its place again: before where the crumb was.
    expect(host.firstElementChild?.firstElementChild?.className).toBe('grid');
});

test('what a Show shows again is built anew, and follows its state', () => {
    const host = document.createElement('div');
    const [shown, setShown] = createSignal(true);
    const [count, setCount] = createSignal(0);
    render(
        () => (
            <div>
                <Show when={shown}>{() => <b>{count}</b>}</Show>
            </div>
        ),
        host,
    );
    setShown(false);
    setShown(true);
    setCount(5);
    expect(host.querySelector('b')?.textContent).toBe('5');
});

test('a For over an accessor follows it', () => {
    const host = document.createElement('div');
    const [items, setItems] = createSignal(['a', 'b', 'c']);
    render(
        () => (
            <div>
                <For each={items}>{(item) => <i>{item}</i>}</For>
            </div>
        ),
        host,
    );
    expect(host.querySelectorAll('i').length).toBe(3);
    setItems(['a']);
    expect(host.querySelectorAll('i').length).toBe(1);
});
