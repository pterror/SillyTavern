import type { Named } from '@st/page/name';

/** A presentation of the repository's latest server answer, never a second character store. */
export type Row = {
    id: string;
    entity: string;
    type: 'character' | 'group' | 'folder';
    name: string;
    thing: string;
    image: string;
    favorite: boolean;
    assistant: boolean;
    description: string;
    auxiliary: string;
    filename: string;
    position: number;
    count: string;
    members: Named[];
};
export type BrowserView = { rows: Row[]; page: number; size: number; total: number; approximate: boolean };
export type OldPage = {
    page(this: void, page: number): Promise<void>;
    size(size: number): Promise<void>;
    tags(element: HTMLElement, entity: string): void | (() => void);
    avatar(element: HTMLElement, entity: string): void;
};
