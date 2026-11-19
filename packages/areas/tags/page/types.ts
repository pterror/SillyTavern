import type { Placement } from '@st/page/reorder';

export type Row = {
    id: string;
    name: string;
    thing: string | undefined;
    unsaved: boolean;
    count: string;
    kept: boolean;
    hidden: boolean;
    folder: { class: string; title: string; icon: string; color: string; size: number };
};
export type ManagerView = {
    rows: Row[];
    sort: string;
    search: string;
    status: '' | 'loading' | 'failed' | 'paused' | 'end';
};
export type ManagerPorts = {
    move(this: void, id: string, placement: Placement): Promise<void>;
    reordering(this: void, active: boolean): void;
    search(this: void, value: string): void;
    sort(this: void, value: string): void;
    read(this: void, kind: string): void;
    draft(this: void, id: string, value: string): void;
    rename(this: void, id: string): Promise<void>;
    folder(this: void, id: string): Promise<void>;
    hide(this: void, id: string): Promise<void>;
    look(this: void, id: string): Promise<void>;
    remove(this: void, id: string): Promise<void>;
    create(this: void): Promise<void>;
    backup(this: void): void;
    restore(this: void): void;
    prune(this: void): Promise<void>;
    leftRows(this: void): void;
};
