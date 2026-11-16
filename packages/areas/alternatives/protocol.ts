import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';

export const LIST_VIEW = 'alternatives.list';
export const COUNTS_VIEW = 'alternatives.counts';
export const MATCHES_VIEW = 'alternatives.matches';
export const VIEWS = [LIST_VIEW, COUNTS_VIEW, MATCHES_VIEW] as const;

const target = v.union([
    v.object({ message: v.pipe(v.string(), v.minLength(1)) }),
    v.object({ opening: v.literal(true) }),
    v.object({ greetings: v.pipe(v.string(), v.minLength(1)) }),
]);

export type Target = v.InferOutput<typeof target>;

const tokenizer = v.looseObject({ api: v.pipe(v.string(), v.minLength(1)) });

export type TokenizerState = v.InferOutput<typeof tokenizer>;

export type Item = {
    id: string;
    index: number;
    text: string;
    name: string;
    role: 'user' | 'assistant' | 'system';
    date: string | number | null;
    nodeId: string | null;
    /** the card greeting it is (a stored opening: the one it is linked to), on the card of its character */
    card: CardPlace | null;
    opening: number | null;
    /** the values of the macros it draws, each macro's source to its value, null for one only known when sent */
    macros: Record<string, string | null> | null;
};

/** a card greeting by its character and id, with its text's hash as the card's operations take it, at `position` of its card */
export type CardPlace = { avatar: string; id: number; position: number; hash: number };

/** a card the list's rows are greetings of */
export type CardView = {
    avatar: string;
    /** `ids[k]` the id of `greetings[k]` */
    ids: number[];
    greetings: string[];
    hashes: number[];
    defaultPosition: number | null;
};

export type ListView = {
    target: Target | null;
    items: Item[];
    total: number;
    complete: boolean;
    current: number | null;
    /** every card a row is a greeting of; a character's list, or its chat's, has its card even with no greetings */
    cards: CardView[];
    /** the card a new greeting is added to; null for a group's first message */
    addsTo: string | null;
    chatOpen: boolean;
};

export type CountsView = { counts: Record<string, number> };

export type MatchesView = {
    query: string;
    matches: Record<string, number[]> | null;
    checked: number;
    total: number;
};

const id = v.pipe(v.number(), v.integer(), v.minValue(0));
const hash = v.pipe(v.number(), v.finite());
const avatar = v.pipe(v.string(), v.minLength(1));

export const actions = {
    'alternatives.open': v.object({ target, tokenizer: v.nullable(tokenizer) }),
    'alternatives.close': v.object({}),
    'alternatives.search': v.object({ query: v.string() }),
    'alternatives.greeting': v.variant('op', [
        v.object({ op: v.literal('add'), avatar, text: v.pipe(v.string(), v.minLength(1)) }),
        v.object({ op: v.literal('edit'), avatar, id, hash, text: v.string() }),
        v.object({ op: v.literal('delete'), avatar, id, hash }),
        v.object({
            op: v.literal('move'),
            avatar,
            id,
            hash,
            side: v.picklist(['before', 'after']),
            target: id,
            targetHash: hash,
        }),
        v.object({ op: v.literal('default'), avatar, id, hash }),
        v.object({ op: v.literal('undefault'), avatar, id, hash }),
    ]),
    'alternatives.move': v.object({
        nodeId: v.pipe(v.string(), v.minLength(1)),
        side: v.picklist(['before', 'after']),
        target: v.pipe(v.string(), v.minLength(1)),
    }),
} satisfies ActionSchemas;

export type GreetingOp = v.InferOutput<(typeof actions)['alternatives.greeting']>;
