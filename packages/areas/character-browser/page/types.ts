import type { TagChip } from '@st/page/tags';
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
    tags: TagChip[];
    groupAvatar?: { images: string[]; custom: boolean };
    member?: { disabled: boolean; queue: number; existingGroup: boolean };
};
export type BrowserView = { rows: Row[]; page: number; size: number; total: number; approximate: boolean };
export type OldPage = {
    page(this: void, page: number): Promise<void>;
    size(size: number): Promise<void>;
};

export type MemberAction = 'add' | 'remove' | 'enable' | 'disable' | 'up' | 'down' | 'view' | 'speak';
export type GroupPorts = OldPage & { action(this: void, id: string, action: MemberAction): Promise<void> };
