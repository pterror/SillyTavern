import { render } from '@solidjs/web';
import { flush } from 'solid-js';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { createCommands } from '@st/page/commands';
import { createFocusActions } from '@st/page/focus-actions';
import { createClient } from '@st/page/client';
import { UiProvider } from '@st/page/context';
import { TagManager, createManager } from './Manager.tsx';
import type { ManagerPorts, Row } from './types.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});
const row = (id = 'one'): Row => ({
    id,
    name: 'One',
    thing: undefined,
    unsaved: false,
    count: '2',
    kept: false,
    hidden: false,
    folder: { class: 'no_folder', title: 'No Folder', icon: '✕', color: 'red', size: 1 },
});
function mount() {
    const manager = createManager();
    const old: ManagerPorts = {
        move: vi.fn(async () => {}),
        reordering: vi.fn(),
        search: vi.fn(),
        sort: vi.fn(),
        read: vi.fn(),
        draft: vi.fn(),
        rename: vi.fn(async () => {}),
        folder: vi.fn(async () => {}),
        hide: vi.fn(async () => {}),
        look: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        create: vi.fn(async () => {}),
        backup: vi.fn(),
        restore: vi.fn(),
        prune: vi.fn(async () => {}),
        leftRows: vi.fn(),
    };
    const t = (text: string) => text;
    const commands = createCommands();
    const ui = {
        t,
        commands,
        focusActions: createFocusActions(commands, t),
        client: createClient({ headers: () => ({}) }),
    };
    const host = document.createElement('div');
    document.body.append(host);
    const dispose = render(
        () => (
            <UiProvider value={ui}>
                <TagManager manager={manager} old={old} />
            </UiProvider>
        ),
        host,
    );
    cleanups.push(() => {
        dispose();
        host.remove();
    });
    const show = (rows: Row[]) => {
        manager.show({ rows, sort: 'manual', search: '', status: '' });
    };
    show([row()]);
    return { manager, old, host, show };
}

test('a background row snapshot preserves focused content and reports a draft before committing on blur', () => {
    const s = mount();
    const field = s.host.querySelector<HTMLElement>('.tag_view_name')!;
    field.focus();
    field.textContent = 'Half typed';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(s.old.draft).toHaveBeenCalledWith('one', 'Half typed');
    s.show([{ ...row(), name: 'Changed elsewhere', count: '8' }]);
    expect(s.host.querySelector('.tag_view_name')).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.textContent).toBe('Half typed');
    expect(s.host.querySelector('.tag_view_counter_value')?.textContent).toBe('8');
    field.blur();
    expect(s.old.rename).toHaveBeenCalledWith('one');
    flush();
    expect(field.textContent).toBe('Changed elsewhere');
});

test('keyed row moves and removals preserve the remaining editors', () => {
    const s = mount();
    s.show([row('one'), row('two')]);
    const second = s.host.querySelector('#two')!;
    s.show([row('two'), { ...row('one'), kept: true }]);
    expect(s.host.querySelector('.tag_view_item')).toBe(second);
    s.show([row('two')]);
    expect(s.host.querySelector('#two')).toBe(second);
    expect(s.host.querySelector('#one')).toBeNull();
});

test('Enter commits the name through the field action without activating the surrounding dialog', () => {
    const s = mount();
    const field = s.host.querySelector<HTMLElement>('.tag_view_name')!;
    field.focus();
    const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    field.dispatchEvent(key);
    flush();
    expect(s.old.rename).toHaveBeenCalledWith('one');
    expect(key.defaultPrevented).toBe(true);
});

test('the focused handle uses row movement commands and keeps focus when the answer changes order', async () => {
    const s = mount();
    s.show([row('one'), row('two')]);
    const handle = s.host.querySelector<HTMLButtonElement>('#two .drag-handle')!;
    handle.focus();
    const key = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    handle.dispatchEvent(key);
    flush();
    expect(key.defaultPrevented).toBe(true);
    expect(s.old.move).toHaveBeenCalledExactlyOnceWith('two', { before: 'one' });
    await vi.waitFor(() => expect(s.old.reordering).toHaveBeenLastCalledWith(false));
    s.show([row('two'), row('one')]);
    expect(s.host.querySelector('#two .drag-handle')).toBe(handle);
    expect(document.activeElement).toBe(handle);
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(s.old.move).toHaveBeenCalledTimes(1);
});
