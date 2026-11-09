import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';
import type { Looks, Named } from '@st/protocol/looks';

export const VIEW = 'activations.panel';
export const PEEK_VIEW = 'activations.peek';

export type Opener = { book: string; uid: number } | { card: string } | null;

export type Where = { message: string; spans: [number, number][] } | { field: string } | { inject: string };

// `thing` null: what has no record of its own to draw by (a removed entry, a card's book).
export type Label = Named | { thing: null; text: string };

export type Shown = {
    label: Label;
    world: Label;
    start: string;
    open: Opener;
    why: 'key' | 'always' | 'sticky' | 'decorator';
    keys: { key: string; where: Where[] }[];
    via: number[];
};

export type Cut = { label: Label; world: Label; start: string; open: Opener; why: 'budget' | 'chance' | 'group' };

export type PanelView = { message: string | null; entries: Shown[]; cut: Cut[]; looks: Looks };

export const actions = {
    'activations.open': v.object({ message: v.pipe(v.string(), v.minLength(1)) }),
    'activations.close': v.object({}),
    'activations.peek': v.object({ message: v.pipe(v.string(), v.minLength(1)) }),
} satisfies ActionSchemas;
