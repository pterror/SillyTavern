import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';

export const VIEW = 'activations.panel';

export type Opener = { book: string; uid: number } | { card: string } | null;

export type Where = { message: string; spans: [number, number][] } | { field: string } | { inject: string };

export type Shown = {
    title: string;
    book: string;
    open: Opener;
    why: 'key' | 'always' | 'sticky' | 'decorator' | 'external';
    keys: { key: string; where: Where[] }[];
    via: number[];
};

export type Cut = { title: string; book: string; open: Opener; why: 'budget' | 'chance' | 'group' };

export type PanelView = { message: string | null; entries: Shown[]; cut: Cut[] };

export const actions = {
    'activations.open': v.object({ message: v.pipe(v.string(), v.minLength(1)) }),
    'activations.close': v.object({}),
} satisfies ActionSchemas;
