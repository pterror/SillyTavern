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
    card: { position: number; hash: number } | null;
    opening: number | null;
};

export type ListView = {
    target: Target | null;
    items: Item[];
    total: number;
    complete: boolean;
    current: number | null;
    card: { avatar: string; greetings: string[]; hashes: number[]; defaultPosition: number | null } | null;
    chatOpen: boolean;
};

export type CountsView = { counts: Record<string, number> };

export type MatchesView = {
    query: string;
    matches: Record<string, number[]> | null;
    checked: number;
    total: number;
};

const position = v.pipe(v.number(), v.integer(), v.minValue(0));
const hash = v.pipe(v.number(), v.finite());

export const actions = {
    'alternatives.open': v.object({ target, tokenizer: v.nullable(tokenizer) }),
    'alternatives.close': v.object({}),
    'alternatives.search': v.object({ query: v.string() }),
    'alternatives.greeting': v.variant('op', [
        v.object({ op: v.literal('add'), text: v.pipe(v.string(), v.minLength(1)) }),
        v.object({ op: v.literal('edit'), position, hash, text: v.string() }),
        v.object({ op: v.literal('delete'), position, hash }),
        v.object({
            op: v.literal('move'),
            position,
            hash,
            side: v.picklist(['before', 'after']),
            target: position,
            targetHash: hash,
        }),
        v.object({ op: v.literal('default'), position, hash }),
        v.object({ op: v.literal('undefault'), hash }),
    ]),
} satisfies ActionSchemas;

export type GreetingOp = v.InferOutput<(typeof actions)['alternatives.greeting']>;
