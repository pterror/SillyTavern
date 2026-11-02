import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';

export const VIEW = 'backgrounds';
export const CHAT_VIEW = 'backgrounds.chat';

export const FITTINGS = ['classic', 'cover', 'contain', 'stretch', 'center'] as const;
export const SORT_ORDERS = ['az', 'za', 'newest', 'oldest'] as const;
export const COLUMNS = { min: 2, max: 8 } as const;

export type Fitting = (typeof FITTINGS)[number];
export type SortOrder = (typeof SORT_ORDERS)[number];

export type Background = {
    id: string;
    file: string;
    title: string;
    url: string;
    thumbnail: string;
    animated: boolean;
    color: string | null;
    aspect: number | null;
    folders: string[];
};

export type Folder = { id: string; name: string; cover: string | null };

export type Ref = { file: string; chat: boolean };

export type BackgroundsView = {
    system: Background[];
    folders: Folder[];
    selected: Ref;
    options: { fitting: Fitting; animatedThumbnails: boolean; sortOrder: SortOrder; columns: number | null };
};

export type ChatBackgroundsView = {
    chat: { backgrounds: Background[]; locked: Ref | null } | null;
    shown: { url: string };
};

const ref = v.object({ file: v.pipe(v.string(), v.minLength(1)), chat: v.boolean() });
const name = v.pipe(v.string(), v.trim(), v.minLength(1));

export const actions = {
    'backgrounds.select': v.object({ ...ref.entries, forUser: v.boolean() }),
    'backgrounds.lock': v.object({ background: v.nullable(ref) }),
    'backgrounds.unlock': v.object({}),
    'backgrounds.upload': v.object({ chat: v.boolean() }),
    'backgrounds.rename': v.object({ file: v.pipe(v.string(), v.minLength(1)), name }),
    'backgrounds.delete': v.object({ ...ref.entries, deleteFile: v.boolean() }),
    'backgrounds.copyToSystem': v.object({ file: v.pipe(v.string(), v.minLength(1)), name }),
    'backgrounds.addToChat': v.object({ file: v.pipe(v.string(), v.minLength(1)) }),
    'backgrounds.pickByTitle': v.object({ reply: v.string() }),
    'backgrounds.options': v.partial(
        v.object({
            fitting: v.picklist(FITTINGS),
            animatedThumbnails: v.boolean(),
            sortOrder: v.picklist(SORT_ORDERS),
            columns: v.pipe(v.number(), v.integer(), v.minValue(COLUMNS.min), v.maxValue(COLUMNS.max)),
        }),
    ),
    'backgrounds.folders.create': v.object({ name }),
    'backgrounds.folders.rename': v.object({ id: v.string(), name }),
    'backgrounds.folders.delete': v.object({ id: v.string() }),
    'backgrounds.folders.cover': v.object({ id: v.string(), file: v.string() }),
    'backgrounds.folders.add': v.object({ files: v.array(v.string()), folders: v.array(v.string()) }),
    'backgrounds.folders.remove': v.object({ files: v.array(v.string()), folder: v.string() }),
    'backgrounds.folders.set': v.object({ file: v.string(), folders: v.array(v.string()) }),
} satisfies ActionSchemas;

export const fileActions: ReadonlySet<keyof typeof actions> = new Set(['backgrounds.upload']);
