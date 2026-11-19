import { render } from '@solidjs/web';
import { flush } from 'solid-js';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { createCommands } from '@st/page/commands';
import { createFocusActions } from '@st/page/focus-actions';
import { createClient } from '@st/page/client';
import { UiProvider } from '@st/page/context';
import { DeleteTag } from './Delete.tsx';
import type { DeletePorts, MergeTag } from './Delete.tsx';

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});
function mount(search: DeletePorts['search']) {
    const choose = vi.fn();
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
                <DeleteTag tag={{ id: 'source', name: 'Source' }} old={{ search, choose }} />
            </UiProvider>
        ),
        host,
    );
    cleanups.push(() => {
        dispose();
        host.remove();
    });
    const input = host.querySelector<HTMLInputElement>('input')!;
    const type = (term: string) => {
        input.value = term;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        flush();
    };
    const pick = async (name: string) => {
        host.querySelector<HTMLButtonElement>('#merge_tag_select')!.click();
        flush();
        const option = await vi.waitFor(() => {
            const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
                (element) => element.textContent === name,
            );
            expect(found).toBeDefined();
            return found!;
        });
        option.click();
        flush();
    };
    return { host, input, type, pick, choose };
}

test('late search results cannot replace a newer answer, and the source tag is excluded', async () => {
    const pending: ((answer: { rows: MergeTag[]; cursor: string | null }) => void)[] = [];
    const s = mount(
        () =>
            new Promise((resolve) => {
                pending.push(resolve);
            }),
    );
    s.type('new');
    pending[1]!({
        rows: [
            { id: 'source', name: 'Source' },
            { id: 'new', name: 'New' },
        ],
        cursor: null,
    });
    await vi.waitFor(() => expect(s.host.textContent).not.toContain('Loading tags...'));
    pending[0]!({ rows: [{ id: 'old', name: 'Old' }], cursor: null });
    await Promise.resolve();
    flush();
    await s.pick('New');
    expect(s.choose).toHaveBeenCalledWith({ id: 'new', name: 'New' });
    s.host.querySelector<HTMLButtonElement>('#merge_tag_select')!.click();
    flush();
    expect([...document.querySelectorAll('[role="option"]')].map((element) => element.textContent)).toEqual([
        'Delete without merging',
        'New',
    ]);
});

test('search failures can be retried and later pages are selectable', async () => {
    const read = vi
        .fn<DeletePorts['search']>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ rows: [{ id: 'first', name: 'First' }], cursor: 'next' })
        .mockResolvedValueOnce({ rows: [{ id: 'last', name: 'Last', thing: '123' }], cursor: null });
    const s = mount(read);
    await vi.waitFor(() => expect(s.host.textContent).toContain('The tags could not be loaded.'));
    [...s.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Try again')!
        .click();
    flush();
    const more = await vi.waitFor(() => {
        const button = s.host.querySelector<HTMLButtonElement>('.tag_merge_more');
        expect(button).not.toBeNull();
        return button!;
    });
    more.click();
    flush();
    await vi.waitFor(() => expect(read).toHaveBeenLastCalledWith('', 'next'));
    await s.pick('Last');
    expect(s.choose).toHaveBeenLastCalledWith({ id: 'last', name: 'Last', thing: '123' });
    expect(s.host.querySelector('#merge_tag_select .named')).not.toBeNull();
});

test('search keeps the chosen target until it is explicitly cleared, and Enter does not submit deletion', async () => {
    const s = mount(async (term) => ({ rows: term === '' ? [{ id: 'target', name: 'Target' }] : [], cursor: null }));
    await s.pick('Target');
    s.type('something else');
    await vi.waitFor(() => expect(s.host.textContent).toContain('No tag has that name.'));
    expect(s.host.querySelector('#merge_tag_select')?.textContent).toContain('Target');
    s.input.focus();
    const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    s.input.dispatchEvent(key);
    flush();
    expect(key.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(s.host.querySelector('#merge_tag_select'));
    await s.pick('Delete without merging');
    expect(s.choose).toHaveBeenLastCalledWith(null);
});
