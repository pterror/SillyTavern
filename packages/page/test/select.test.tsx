import { createSignal, flush } from 'solid-js';
import { render } from '@solidjs/web';
import { expect, test, vi } from 'vite-plus/test';
import { Select } from '../src/select.tsx';

const OPTIONS = [
    { value: 'a', label: 'Apple' },
    { value: 'b', label: 'Banana' },
    { value: 'c', label: 'Cherry' },
];
const press = (element: Element, key: string) => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    flush();
};
const listOf = (trigger: Element) => document.getElementById(trigger.getAttribute('aria-controls') ?? '');

function mount(refused = false) {
    const host = document.createElement('div');
    document.body.append(host);
    const [value, setValue] = createSignal('a');
    const [disabled, setDisabled] = createSignal(false);
    const changed: string[] = [];
    const dispose = render(
        () => (
            <Select
                id="fruit"
                label="Fruit"
                options={OPTIONS}
                value={value()}
                disabled={disabled()}
                onChange={(next, refuse) => {
                    changed.push(next);
                    if (refused) refuse();
                    else setValue(next);
                }}
            />
        ),
        host,
    );
    const trigger = host.querySelector<HTMLButtonElement>('#fruit')!;
    return {
        host,
        trigger,
        changed,
        setDisabled,
        dispose: () => {
            dispose();
            host.remove();
        },
    };
}

test('the themed select keeps its control id and chooses by keyboard', async () => {
    const s = mount();
    try {
        expect(s.trigger.getAttribute('role')).toBe('combobox');
        expect(s.trigger.textContent).toContain('Apple');
        press(s.trigger, 'ArrowDown');
        await vi.waitFor(() => expect(listOf(s.trigger)?.querySelectorAll('[role=option]')).toHaveLength(3));
        press(s.trigger, 'ArrowDown');
        press(s.trigger, 'Enter');
        await vi.waitFor(() => expect(s.changed).toEqual(['b']));
        expect(s.trigger.textContent).toContain('Banana');
        expect(s.trigger.getAttribute('aria-expanded')).toBe('false');
    } finally {
        s.dispose();
    }
});

test('a refused choice restores the stored value', async () => {
    const s = mount(true);
    try {
        press(s.trigger, 'c');
        await vi.waitFor(() => expect(listOf(s.trigger)?.querySelector('[data-active]')?.textContent).toBe('Cherry'));
        press(s.trigger, 'Enter');
        await vi.waitFor(() => expect(s.changed).toEqual(['c']));
        expect(s.trigger.textContent).toContain('Apple');
    } finally {
        s.dispose();
    }
});

test('disabling an open select closes it without sending a choice', () => {
    const s = mount();
    try {
        press(s.trigger, 'ArrowDown');
        expect(s.trigger.getAttribute('aria-expanded')).toBe('true');
        s.setDisabled(true);
        flush();
        expect(s.trigger.disabled).toBe(true);
        expect(s.trigger.getAttribute('aria-expanded')).toBe('false');
        press(s.trigger, 'ArrowDown');
        expect(s.trigger.getAttribute('aria-expanded')).toBe('false');
        expect(s.changed).toEqual([]);
    } finally {
        s.dispose();
    }
});
