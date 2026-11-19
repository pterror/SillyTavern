import { render } from '@solidjs/web';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { UiProvider } from '@st/page/context';
import type { Ui } from '@st/page/context';
import { AssignedTags, createAssigned } from './Assigned.tsx';
import type { AssignedTag } from './Assigned.tsx';
const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});
const tag = (id: string): AssignedTag => ({
    id,
    name: id,
    thing: '123',
    className: '',
    title: '',
    icon: '',
    removable: true,
    inactive: false,
    actionable: false,
});
function mount() {
    const list = createAssigned();
    const remove = vi.fn(),
        expand = vi.fn(),
        activate = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const ui = { t: (text: string) => text } as unknown as Ui;
    const dispose = render(
        () => (
            <UiProvider value={ui}>
                <AssignedTags list={list} old={{ remove, expand, activate }} />
            </UiProvider>
        ),
        host,
    );
    cleanups.push(() => {
        dispose();
        host.remove();
    });
    return { list, host, remove, expand, activate };
}
test('a tag refresh preserves chip and removal-button focus while updating its name and look', () => {
    const s = mount();
    s.list.show({ tags: [tag('one'), tag('two')], skipped: 0 });
    const chip = s.host.querySelector('#one')!;
    const remove = chip.querySelector<HTMLButtonElement>('button')!;
    remove.focus();
    s.list.show({ tags: [tag('two'), { ...tag('one'), name: 'Renamed', thing: '456' }], skipped: 0 });
    expect(s.host.querySelector('#one')).toBe(chip);
    expect(document.activeElement).toBe(remove);
    expect(chip.classList.contains('look-456')).toBe(true);
    expect(chip.querySelector('.tag_name')?.textContent).toBe('Renamed');
    remove.click();
    expect(s.remove).toHaveBeenCalledExactlyOnceWith('one');
    expect(s.activate).not.toHaveBeenCalled();
    expect(s.host.querySelector('#one')).toBe(chip);
});
test('expansion is an action, and snapshots control the overflow and removable state', () => {
    const s = mount();
    s.list.show({ tags: [{ ...tag('one'), removable: false }], skipped: 5 });
    expect(s.host.querySelector('.tag_remove')).toBeNull();
    s.host.querySelector<HTMLButtonElement>('.placeholder-expander')!.click();
    expect(s.expand).toHaveBeenCalledOnce();
    expect(s.host.querySelector('.placeholder-expander')).not.toBeNull();
    s.list.show({ tags: [tag('one'), tag('two')], skipped: 0 });
    expect(s.host.querySelector('.placeholder-expander')).toBeNull();
});
