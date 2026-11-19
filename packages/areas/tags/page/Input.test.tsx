import { render } from '@solidjs/web';
import { flush } from 'solid-js';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { createCommands } from '@st/page/commands';
import { createFocusActions } from '@st/page/focus-actions';
import { createClient } from '@st/page/client';
import { UiProvider } from '@st/page/context';
import { TagInput } from './Input.tsx';
import type { InputPorts, TagSuggestion } from './Input.tsx';
const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});
function mount(search: InputPorts['search'], choose = vi.fn(async () => {})) {
    const host = document.createElement('div');
    document.body.append(host);
    const t = (text: string) => text;
    const commands = createCommands();
    const ui = {
        t,
        commands,
        focusActions: createFocusActions(commands, t),
        client: createClient({ headers: () => ({}) }),
    };
    const dispose = render(
        () => (
            <UiProvider value={ui}>
                <TagInput
                    config={{ id: 'tags', className: 'tag_input', placeholder: 'Tags' }}
                    old={{ search, choose }}
                />
            </UiProvider>
        ),
        host,
    );
    cleanups.push(() => {
        dispose();
        host.remove();
    });
    const input = host.querySelector<HTMLInputElement>('input')!;
    const type = (text: string) => {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        flush();
    };
    const press = (key: string) => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        flush();
    };
    input.focus();
    flush();
    return { host, input, type, press, choose, dispose, commands };
}

test('late search answers cannot replace the current suggestions', async () => {
    const pending: ((rows: TagSuggestion[]) => void)[] = [];
    const s = mount(
        () =>
            new Promise((resolve) => {
                pending.push(resolve);
            }),
    );
    s.type('new');
    pending[1]!([{ value: 'New' }]);
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toBe('New'));
    pending[0]!([{ value: 'Old' }]);
    await Promise.resolve();
    flush();
    expect(document.querySelector('[role="option"]')?.textContent).toBe('New');
});

test('keyboard movement names a drawn option while focus stays in the input, and Enter adds it once', async () => {
    const s = mount(async () => [{ value: 'First' }, { value: 'Second', thing: '123' }]);
    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(2));
    s.press('ArrowDown');
    await vi.waitFor(() =>
        expect(document.getElementById(s.input.getAttribute('aria-activedescendant') ?? '')?.textContent).toBe('First'),
    );
    s.press('ArrowDown');
    await vi.waitFor(() =>
        expect(document.getElementById(s.input.getAttribute('aria-activedescendant') ?? '')?.textContent).toBe(
            'Second',
        ),
    );
    expect(document.activeElement).toBe(s.input);
    s.press('Enter');
    expect(s.choose).toHaveBeenCalledExactlyOnceWith('Second');
    expect(s.input.value).toBe('');
    expect(s.input.getAttribute('aria-expanded')).toBe('false');
    expect(s.input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(document.querySelector('.st-autocomplete-menu')).toBeNull();
});

test('Escape closes pending suggestions and their late answer cannot reopen the popup', async () => {
    let answer: (rows: TagSuggestion[]) => void = () => {};
    const s = mount(
        () =>
            new Promise((resolve) => {
                answer = resolve;
            }),
    );
    const parentClose = vi.fn();
    const unregister = s.commands.register([
        {
            id: 'parent.close',
            label: 'Close parent',
            category: 'Panels',
            keys: ['Escape'],
            typing: true,
            run: parentClose,
        },
    ]);
    cleanups.push(unregister);
    s.press('Escape');
    expect(parentClose).not.toHaveBeenCalled();
    answer([{ value: 'Late' }]);
    await Promise.resolve();
    flush();
    expect(document.querySelector('.st-autocomplete-menu')).toBeNull();
    expect(s.input.getAttribute('aria-expanded')).toBe('false');
    expect(s.choose).not.toHaveBeenCalled();
});

test('a second selection is not dropped while the first tag is being created', async () => {
    const choose = vi.fn(() => new Promise<void>(() => {}));
    const s = mount(async (term) => [{ value: term === '' ? 'First' : term }], choose);
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toBe('First'));
    s.press('Enter');
    s.type('Second');
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toBe('Second'));
    s.press('Enter');
    expect(choose.mock.calls).toEqual([['First'], ['Second']]);
});
