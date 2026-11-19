import { createSignal, createStore, flush, reconcile } from 'solid-js';
import { preserveFocus } from '@st/page/element';
import type { TagChip as FolderChip } from '@st/page/tags';

export type Condition = { field: string; op: 'contains' | 'not_contains'; value: string };
export type Bound = { min?: number; max?: number };
export type FilterView = {
    text: string;
    conditions: Condition[];
    tags: { include: string[]; exclude: string[]; mode?: 'and' | 'or' };
    fav: boolean | undefined;
    group: boolean | undefined;
    ranges?: Record<string, Bound> | undefined;
    sort: {
        field: string;
        order: 'asc' | 'desc';
        seed?: number;
        tie?: { field: string; order: 'asc' | 'desc'; seed?: number };
    };
    folderCase: string;
};
export type Tag = { id: string; name: string; thing?: string; shownAs?: string };
export type TagChip = Tag & { icon: string; className: string; title: string; state: string; action: boolean };
export type TagBarView = {
    tags: TagChip[];
    folders: FolderChip[];
    visible: boolean;
    tail: 'more' | 'failed' | null;
    expanded: boolean;
};
export type SavedState = {
    current: string | null;
    name: string;
    dirty: boolean;
    pending: boolean;
    open: boolean;
    filter: string;
    views: { id: string; name: string }[];
    folders: Tag[];
    more: boolean;
    moreFolders: boolean;
};
export type SearchView = { view: FilterView; sort: string; searchSort: boolean; random: boolean };
export type SavedPorts = {
    open(): Promise<void>;
    close(): void;
    choose(id: string | null): void;
    search(term: string): Promise<void>;
    more(folders: boolean): Promise<void>;
    save(name?: string): Promise<void>;
    discard(): void;
    keep(): void;
    rename(id: string, name: string): Promise<void>;
    remove(id: string): Promise<void>;
    move(id: string, direction: number): Promise<void>;
};
export type ControlPorts = {
    change(view: FilterView, typing: boolean): void;
    token(text: string): { text: string; condition: Condition } | null;
    searchTags(term: string): Promise<Tag[] | null>;
    tagNames(ids: string[]): Promise<(Tag & { deleted?: boolean })[] | null>;
    sort(value: string): void;
    reroll(): void;
    sorts: { value: string; label: string; search: boolean }[];
    fields: { value: string; label: string; aliases: string[] }[];
    ranges: { field: string; label: string; unit: 'date' | 'kb' | 'count' }[];
    tagAction(id: string, element: HTMLElement, event: MouseEvent): Promise<void>;
    moreTags(element: HTMLElement, retry: boolean): void;
    removeFolder(this: void, id: string): void;
    saved: SavedPorts;
};

export function createControls() {
    const [search, setSearch] = createSignal<SearchView | null>(null);
    const [tagState, setTags] = createStore<{ value: TagBarView }>({
        value: { tags: [], folders: [], visible: false, tail: null, expanded: false },
    });
    const [savedState, setSaved] = createStore<{ value: SavedState }>({
        value: {
            current: null,
            name: 'All characters',
            dirty: false,
            pending: false,
            open: false,
            filter: '',
            views: [],
            folders: [],
            more: false,
            moreFolders: false,
        },
    });
    return {
        search,
        tags: () => tagState.value,
        saved: () => savedState.value,
        showSearch: (view: SearchView) => {
            flush(() => {
                setSearch(view);
            });
        },
        showTags: (view: TagBarView) => {
            preserveFocus(() =>
                flush(() => {
                    setTags(reconcile({ value: view }, 'id'));
                }),
            );
        },
        showSaved: (view: SavedState) => {
            flush(() => {
                setSaved(reconcile({ value: view }, 'id'));
            });
        },
    };
}
export type Controls = ReturnType<typeof createControls>;
