import { render } from '@solidjs/web';
import { createRoot, flush } from 'solid-js';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { createCommands } from '@st/page/commands';
import { createFocusActions } from '@st/page/focus-actions';
import { createClient } from '@st/page/client';
import { UiProvider } from '@st/page/context';
import { createControls } from './controls.ts';
import type { ControlPorts, FilterView, SavedState, Tag } from './controls.ts';
import { Search } from './Search.tsx';
import { SavedViews } from './SavedViews.tsx';
import { TagFilters } from './TagFilters.tsx';

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});
const view: FilterView = {
    text: '',
    conditions: [],
    tags: { include: [], exclude: [], mode: 'and' },
    fav: undefined,
    group: undefined,
    sort: { field: 'name', order: 'asc' },
    folderCase: 'none',
};
const saved: SavedState = {
    current: null,
    name: 'All characters',
    dirty: false,
    pending: false,
    open: false,
    filter: '',
    views: [{ id: 'one', name: 'One' }],
    folders: [],
    more: false,
    moreFolders: false,
};

function mount() {
    const mounted = createRoot((dispose) => {
        const controls = createControls();
        const changed = vi.fn();
        const old: ControlPorts = {
            change: changed,
            token: () => null,
            searchTags: async () => [],
            tagNames: async () => [],
            sort() {},
            reroll() {},
            sorts: [],
            fields: [{ value: 'name', label: 'Name', aliases: [] }],
            ranges: [],
            tagAction: async () => {},
            moreTags() {},
            saved: {
                open: async () => {
                    controls.showSaved({ ...saved, open: true });
                },
                close: () => {
                    controls.showSaved(saved);
                },
                choose() {},
                search: async () => {},
                more: async () => {},
                save: async () => {},
                discard() {},
                keep() {},
                rename: async () => {},
                remove: async () => {},
                move: async () => {},
            },
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
        const unmount = render(
            () => (
                <UiProvider value={ui}>
                    <Search controls={controls} old={old} />
                    <SavedViews controls={controls} old={old} />
                    <TagFilters controls={controls} old={old} />
                </UiProvider>
            ),
            host,
        );
        cleanups.push(() => {
            unmount();
            dispose();
            host.remove();
        });
        return { controls, old, host, changed };
    });
    mounted.controls.showSearch({ view, sort: 'name:asc', searchSort: false, random: false });
    mounted.controls.showSaved(saved);
    return mounted;
}
const click = (element: Element | null) => {
    (element as HTMLElement).click();
    flush();
};
const input = (element: HTMLInputElement, value: string) => {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    flush();
};

test('typed search is a draft sent through the existing query intent', () => {
    const s = mount();
    input(s.host.querySelector<HTMLInputElement>('#character_search_bar')!, 'castle');
    expect(s.changed).toHaveBeenCalledWith({ ...view, text: 'castle' }, true);
    expect(view.text).toBe('');
});

test('late tag search answers cannot replace the latest results', async () => {
    const s = mount();
    const pending: ((tags: Tag[]) => void)[] = [];
    s.old.searchTags = () =>
        new Promise((resolve) => {
            pending.push(resolve);
        });
    click(s.host.querySelector('.view_pill_add'));
    click(document.querySelector('[data-field="@tag"]'));
    const search = document.querySelector<HTMLInputElement>('.view_pill_popover input')!;
    input(search, 'new');
    pending[1]!([{ id: 'new', name: 'New' }]);
    await vi.waitFor(() => expect(document.querySelector('[data-tag-id="new"]')).not.toBeNull());
    pending[0]!([{ id: 'old', name: 'Old' }]);
    await Promise.resolve();
    flush();
    expect(document.querySelector('[data-tag-id="new"]')).not.toBeNull();
    expect(document.querySelector('[data-tag-id="old"]')).toBeNull();
});

test('a saved-view refresh preserves the rename draft and Escape cancels only that edit', async () => {
    const s = mount();
    click(s.host.querySelector('#character_view_picker'));
    click(document.querySelector('[data-action="rename"]'));
    const editor = document.querySelector<HTMLInputElement>('.view_picker_rename')!;
    input(editor, 'Half typed');
    s.controls.showSaved({
        ...saved,
        open: true,
        views: [
            { id: 'one', name: 'Renamed elsewhere' },
            { id: 'two', name: 'Two' },
        ],
    });
    expect(document.querySelector('.view_picker_rename')).toBe(editor);
    expect(editor.value).toBe('Half typed');
    expect(document.activeElement).toBe(editor);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    flush();
    await vi.waitFor(() => expect(document.querySelector('.view_picker_rename')).toBeNull());
    expect(document.querySelector('.view_picker_popover')).not.toBeNull();
});

test('showing tag filters explicitly overrides the legacy bar’s hidden-chip style', () => {
    const s = mount();
    const tags = [{ id: 'used', name: 'Used', icon: '', className: '', title: '', state: 'UNDEFINED', action: false }];
    s.controls.showTags({ tags, visible: false, tail: null, expanded: false });
    expect(s.host.querySelector<HTMLElement>('#used')?.style.display).toBe('none');
    s.controls.showTags({ tags, visible: true, tail: null, expanded: false });
    expect(s.host.querySelector<HTMLElement>('#used')?.style.display).toBe('inline-flex');
});

test('merged tag aliases share one pill while the query keeps its original IDs', async () => {
    const s = mount();
    s.old.tagNames = async (ids) => ids.map((id) => ({ id, name: 'Merged', shownAs: 'target' }));
    s.controls.showSearch({
        view: { ...view, tags: { include: ['source', 'target'], exclude: [], mode: 'and' } },
        sort: 'name:asc',
        searchSort: false,
        random: false,
    });
    await vi.waitFor(() => expect(s.host.querySelectorAll('.view_tag_pill')).toHaveLength(1));
    expect(s.controls.search()?.view.tags.include).toEqual(['source', 'target']);
    expect(s.changed).not.toHaveBeenCalled();
});

test('tag-filter snapshots preserve the focused chip when its state changes', () => {
    const s = mount();
    const tag = { id: 'used', name: 'Used', icon: '', className: '', title: '', state: 'UNDEFINED', action: false };
    s.controls.showTags({ tags: [tag], visible: true, tail: null, expanded: false });
    const chip = s.host.querySelector<HTMLElement>('#used')!;
    chip.focus();
    s.controls.showTags({ tags: [{ ...tag, state: 'SELECTED' }], visible: true, tail: null, expanded: false });
    expect(s.host.querySelector('#used')).toBe(chip);
    expect(document.activeElement).toBe(chip);
    expect(chip.classList.contains('selected')).toBe(true);
});
