import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';

export const OVERVIEW_VIEW = 'worldbuilding.overview';

export const WINDOW = 200;

export type Relation = { relation: string; target: string; entry: string | null; title: string | null };

export type Card = {
    kind: 'entry';
    key: string;
    entry: string;
    uid: string;
    title: string | null;
    text: string;
    cut: boolean;
    keys: string[];
    relations: Relation[];
    members: number;
    repeat: boolean;
    children: Item[];
};

export type More = { kind: 'more'; key: string; more: number };

export type Item = Card | More;

export type Landed = { key: string; rank: number };

export type OverviewView = {
    book: string | null;
    relation: string | null;
    count: number;
    from: number;
    items: (Card & { rank: number })[];
    active: Landed | null;
};

const id = v.pipe(v.string(), v.regex(/^\d+$/));
const occurrence = v.pipe(v.string(), v.maxLength(4000), v.regex(/^\d+(\/\d+)*(\/\+)?$/));
const rank = v.pipe(v.number(), v.integer(), v.minValue(0));
const span = <T extends { from: number; to: number }>(o: T) => o.to >= o.from && o.to - o.from <= WINDOW;
const spanned = 'A window runs from a rank to a later one, at most 200 apart.';

export const actions = {
    'worldbuilding.open': v.pipe(
        v.object({
            book: id,
            relation: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
            from: rank,
            to: rank,
            around: v.nullable(occurrence),
        }),
        v.check(span, spanned),
    ),
    'worldbuilding.window': v.pipe(v.object({ from: rank, to: rank }), v.check(span, spanned)),
    'worldbuilding.move': v.union([
        v.object({
            from: v.nullable(occurrence),
            by: v.pipe(v.number(), v.integer(), v.minValue(-1000), v.maxValue(1000)),
        }),
        v.object({ from: occurrence, to: v.picklist(['parent', 'child']) }),
    ]),
} satisfies ActionSchemas;
